import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CURRENT_RELEASE, TablePage, WIRE_VERSION } from "@patchy/api";
import { readRecord } from "../../../packages/patchy/src/devState.js";
import type { Prepared } from "../../../packages/patchy/src/devPreparation.js";
import toolchain from "../../../packages/patchy/src/toolchain.json" with { type: "json" };
import * as Server from "./server.js";

it.live(
  "runs inspected queries, actions and nested queries through the dev HTTP server",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".dev-server-test-"
      });
      const stateDir = path.join(root, ".patchy", "dev");
      yield* fs.makeDirectory(path.join(root, "server"), { recursive: true });
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
      yield* fs.makeDirectory(path.join(root, "node_modules"));
      yield* fs.symlink(
        path.join(process.cwd(), "packages/patchy"),
        path.join(root, "node_modules/patchy")
      );
      yield* fs.writeFileString(
        path.join(root, "index.html"),
        "<!doctype html><html><head><title>Server dev</title></head><body>Server dev</body></html>"
      );
      yield* fs.writeFileString(
        path.join(root, "server", "notes.ts"),
        `
      import { query, action, t } from "patchy/server";
      export const list = query({ args: {}, result: t.json(), handler: async ctx => ctx.tables.notes.list() });
      export const add = action({ args: { title: t.text() }, result: t.json(), handler: async (ctx, args) => {
        await ctx.tables.notes.insert({ title: args.title });
        return ctx.run.notes.list({});
      }});
    `
      );
      const prepared: Prepared = {
        patchId: "localdev0000",
        identity: {
          user: { id: "usr_dev", email: "dev@patchy.local", name: "Dev" },
          company: { id: "cmp_dev", handle: "patchy-dev", name: "Patchy Dev" },
          role: "admin",
          machine: { id: "tok_dev", name: "Dev Machine" }
        },
        metadata: { postgres: {}, shared: {} },
        manifest: {
          manifestVersion: 1,
          release: CURRENT_RELEASE,
          tier: 2,
          tables: {
            notes: { description: "Notes", columns: { title: { kind: "text" } }, indexes: {} }
          },
          files: {},
          uses: {}
        }
      };
      const server = yield* Server.servePrepared(
        root,
        stateDir,
        {
          root,
          instance: "http://127.0.0.1:1",
          release: CURRENT_RELEASE,
          identity: prepared.identity,
          nonce: "dev-server-test",
          pid: process.pid,
          birth: "starting"
        },
        { ...prepared, toolchain }
      ).pipe(Effect.scoped, Effect.forkScoped);
      const record = yield* Effect.gen(function* () {
        while (true) {
          const ready = yield* Effect.promise(() => readRecord(stateDir));
          if (ready?.url) return ready;
          yield* Effect.sleep("25 millis");
        }
      }).pipe(Effect.raceFirst(Fiber.join(server)), Effect.timeout("30 seconds"));
      const origin = new URL(record.url!).origin;
      const http = yield* HttpClient.HttpClient;
      const call = (handler: string, args: unknown) =>
        http.execute(
          HttpClientRequest.post(`${origin}/api/runtime/call`).pipe(
            HttpClientRequest.setHeaders({
              origin,
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": '{"userId":"usr_dev"}'
            }),
            HttpClientRequest.bodyJsonUnsafe({
              patchId: prepared.patchId,
              versionId: "ver_000000000000000000000000",
              wire: WIRE_VERSION,
              principal: { userId: "usr_dev" },
              op: "server.call",
              args: { handler, args }
            })
          )
        );
      const first = yield* call("notes.list", {});
      assert.strictEqual(first.status, 200);
      assert.deepStrictEqual(yield* first.json, { ok: true, value: { rows: [], cursor: null } });
      const added = yield* call("notes.add", { title: "Local executor" });
      assert.strictEqual(added.status, 200);
      const written = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ ok: Schema.Literal(true), value: TablePage })
      )(yield* added.json);
      assert.deepStrictEqual(
        written.value.rows.map((row) => row.title),
        ["Local executor"]
      );
      const invalid = yield* call("notes.add", { title: 12 });
      assert.strictEqual(invalid.status, 400);
      const last = yield* call("notes.list", {});
      assert.strictEqual(last.status, 200);
      const listed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ ok: Schema.Literal(true), value: TablePage })
      )(yield* last.json);
      assert.deepStrictEqual(
        listed.value.rows.map((row) => row.title),
        ["Local executor"]
      );
      yield* Fiber.interrupt(server);
      assert.isUndefined((yield* Effect.promise(() => readRecord(stateDir)))?.url);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  60_000
);
