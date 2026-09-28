import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Identity, RuntimeStreamFrame } from "@patchy/api";
import { shellContentSecurityPolicy } from "@patchy/serving/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as DevServer from "./devServer.js";
import { readRecord } from "./devState.js";
import type { Prepared } from "./devPreparation.js";
import { RELEASE, MANIFEST_VERSION, WIRE_VERSION } from "./release.js";
import toolchain from "./toolchain.json" with { type: "json" };

const identity = new Identity({
  user: { id: "local-user", email: "local@example.test", name: "Local" },
  company: { id: "local-company", handle: "local", name: "Local" },
  role: "admin",
  machine: { id: "local-machine", name: "Local machine" }
});

const decodeStreamFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeStreamFrame));

it.live(
  "serves and synchronizes local documents, refuses foreign admission, and swaps completed builds",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Beneath the workspace so Vite resolves from the actual installed toolchain.
      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".dev-runtime-test-"
      });
      const stateDir = path.join(root, ".patchy", "dev");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
      yield* fs.makeDirectory(path.join(root, "node_modules"));
      yield* fs.symlink(
        path.join(process.cwd(), "packages/patchy"),
        path.join(root, "node_modules/patchy")
      );
      const document = (title: string) =>
        `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
      yield* fs.writeFileString(path.join(root, "index.html"), document("First local build"));
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 1,
          tables: {
            notes: {
              description: "Notes identified by id.",
              columns: { title: { kind: "text" } },
              indexes: {}
            }
          },
          files: {},
          uses: {}
        },
        identity,
        metadata: { postgres: {}, shared: {} }
      };
      const server = yield* DevServer.serve(
        prepared,
        stateDir,
        {
          root,
          instance: "https://metadata.example.test",
          nonce: "local-test",
          release: RELEASE,
          identity: prepared.identity,
          pid: process.pid,
          birth: "starting"
        },
        toolchain
      ).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        while (!(yield* Effect.promise(() => readRecord(stateDir)))?.url)
          yield* Effect.sleep("25 millis");
      }).pipe(Effect.raceFirst(Fiber.join(server)), Effect.timeout("15 seconds"));
      const origin = yield* HttpServer.addressFormattedWith(Effect.succeed);
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(origin))
      );
      const base = `/dev/${prepared.patchId}`;
      const content = `/~content/${prepared.patchId}/ver_000000000000000000000000`;
      const shell = yield* http.get(base);
      assert.strictEqual(shell.status, 200);
      assert.strictEqual(shell.headers["content-security-policy"], shellContentSecurityPolicy(1));
      assert.include(yield* shell.text, content);
      const initial = yield* http.get(content);
      assert.include(initial.headers["content-security-policy"]!, "connect-src 'none'");
      assert.include(yield* initial.text, "First local build");

      const call = (op: string, args: unknown, from = origin) =>
        http.execute(
          HttpClientRequest.post("/api/runtime/call").pipe(
            HttpClientRequest.setHeaders({
              origin: from,
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: prepared.identity.user.id })
            }),
            HttpClientRequest.bodyJsonUnsafe({
              patchId: prepared.patchId,
              versionId: "ver_000000000000000000000000",
              wire: WIRE_VERSION,
              principal: { userId: prepared.identity.user.id },
              op,
              args
            })
          )
        );
      const refused = yield* call(
        "tables.insert",
        { table: "notes", row: { title: "Forbidden" } },
        "https://foreign.example.test"
      );
      assert.strictEqual(refused.status, 403);
      const invalid = yield* call("tables.insert", { table: "notes", row: { title: 42 } });
      const failure = yield* invalid.json;
      assert.propertyVal(failure, "code", "invalid_row");
      assert.notProperty(failure, "correlationId");
      const subscribe = Effect.fn(function* (documentId: string) {
        const frames = yield* Queue.make<RuntimeStreamFrame>();
        const query = new URLSearchParams({
          patchId: prepared.patchId,
          versionId: "ver_000000000000000000000000",
          documentId
        });
        const stream = yield* http.execute(
          HttpClientRequest.get(`/api/runtime/stream?${query}`).pipe(
            HttpClientRequest.setHeaders({
              origin,
              "sec-fetch-site": "same-origin",
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: prepared.identity.user.id })
            })
          )
        );
        assert.strictEqual(stream.status, 200);
        yield* stream.stream.pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.mapEffect((event) => decodeStreamFrame(event.data)),
          Stream.runForEach((frame) => Queue.offer(frames, frame)),
          Effect.forkScoped
        );
        const hello = yield* Queue.take(frames).pipe(Effect.timeout("5 seconds"));
        if (hello.type !== "hello") return yield* Effect.die("The local stream needs a hello.");
        const response = yield* http.execute(
          HttpClientRequest.post("/api/runtime/subscriptions").pipe(
            HttpClientRequest.setHeaders({
              origin,
              "sec-fetch-site": "same-origin",
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: prepared.identity.user.id })
            }),
            HttpClientRequest.bodyJsonUnsafe({
              patchId: prepared.patchId,
              versionId: "ver_000000000000000000000000",
              documentId,
              generation: hello.generation,
              sequence: 0,
              type: "replace",
              subscriptions: [{ id: "notes", op: "tables.list", args: { table: "notes" } }]
            })
          )
        );
        assert.strictEqual(response.status, 200);
        yield* response.text;
        return Effect.gen(function* () {
          while (true) {
            const frame = yield* Queue.take(frames);
            if (frame.type === "snapshot") return frame.result;
            assert.notStrictEqual(frame.type, "error");
          }
        }).pipe(Effect.timeout("5 seconds"));
      });
      const firstDocument = yield* subscribe("local-document-first");
      const secondDocument = yield* subscribe("local-document-second");
      assert.deepStrictEqual(yield* firstDocument, { rows: [], cursor: null });
      assert.deepStrictEqual(yield* secondDocument, { rows: [], cursor: null });
      const inserted = yield* call("tables.insert", {
        table: "notes",
        row: { title: "Local persisted note" }
      });
      assert.strictEqual(inserted.status, 200);
      assert.nestedPropertyVal(yield* inserted.json, "value.title", "Local persisted note");
      for (const next of [firstDocument, secondDocument]) {
        const snapshot = yield* next;
        assert.nestedPropertyVal(snapshot, "rows[0].title", "Local persisted note");
        assert.nestedPropertyVal(snapshot, "rows.length", 1);
      }
      const listed = yield* call("tables.list", { table: "notes", limit: 10 });
      const result = yield* listed.json;
      assert.nestedPropertyVal(result, "value.rows[0].title", "Local persisted note");
      assert.nestedPropertyVal(result, "value.rows.length", 1);

      yield* fs.writeFileString(path.join(root, "index.html"), document("Second local build"));
      yield* Effect.gen(function* () {
        while ((yield* (yield* http.get("/~dev/build")).text) === "1")
          yield* Effect.sleep("25 millis");
      }).pipe(Effect.raceFirst(Fiber.join(server)), Effect.timeout("10 seconds"));
      assert.include(yield* (yield* http.get(content)).text, "Second local build");
      assert.strictEqual((yield* http.get(`${base}/notes/7`)).status, 200);
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttp),
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provide(NodeServices.layer)
    ),
  { timeout: 30_000 }
);

it.live(
  "keeps tier-zero shell policy and grants only the local reload endpoints",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".dev-static-test-"
      });
      const stateDir = path.join(root, ".patchy", "dev");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
      yield* fs.makeDirectory(path.join(root, "node_modules"));
      yield* fs.symlink(
        path.join(process.cwd(), "packages/patchy"),
        path.join(root, "node_modules/patchy")
      );
      yield* fs.writeFileString(
        path.join(root, "index.html"),
        "<!doctype html><html><head><title>Static patch</title></head><body>Static content</body></html>"
      );
      const prepared: Prepared = {
        patchId: "localdev0000",
        manifest: {
          release: RELEASE,
          manifestVersion: MANIFEST_VERSION,
          tier: 0,
          tables: {},
          files: {},
          uses: {}
        },
        identity,
        metadata: { postgres: {}, shared: {} }
      };
      const server = yield* DevServer.serve(
        prepared,
        stateDir,
        {
          root,
          instance: "https://metadata.example.test",
          nonce: "static-test",
          release: RELEASE,
          identity,
          pid: process.pid,
          birth: "starting"
        },
        toolchain
      ).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        while (!(yield* Effect.promise(() => readRecord(stateDir)))?.url)
          yield* Effect.sleep("25 millis");
      }).pipe(Effect.raceFirst(Fiber.join(server)), Effect.timeout("15 seconds"));
      const origin = yield* HttpServer.addressFormattedWith(Effect.succeed);
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(origin))
      );
      const response = yield* http.get(`/dev/${prepared.patchId}`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.headers["content-security-policy"],
        `${shellContentSecurityPolicy(0)}; script-src ${origin}/~dev/reload.js; connect-src ${origin}/~dev/build`
      );
      const html = yield* response.text;
      assert.include(html, 'sandbox=""');
      assert.include(html, "srcdoc=");
      assert.notInclude(html, "/~shell/broker.js");
      assert.include(html, 'src="/~dev/reload.js?v=1"');
      const reload = yield* http.get("/~dev/reload.js");
      assert.strictEqual(reload.status, 200);
      assert.include(reload.headers["content-type"]!, "text/javascript");
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttp),
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provide(NodeServices.layer)
    ),
  { timeout: 30_000 }
);
