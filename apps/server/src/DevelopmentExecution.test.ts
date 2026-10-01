import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import { CURRENT_RELEASE, WIRE_VERSION, type Manifest } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Runtime } from "@patchy/runtime";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { contentHash, sha256 } from "../../../packages/core/src/index.js";
import * as LocalTaskProvider from "@patchy/execution/local-task-provider";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { answer, publish, send, server } from "./test/server.js";

const origin = "https://patchy.example";
const fixtures = [
  {
    patchId: "devexec00001",
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    companyId: DEV_SEED.companyId,
    userId: DEV_SEED.userId,
    clerkUserId: DEV_SEED.clerkUserId,
    email: DEV_SEED.email
  },
  {
    patchId: "devexec00002",
    versionId: "ver_bbbbbbbbbbbbbbbbbbbbbbbb",
    companyId: "cmp_execution_other",
    userId: "usr_execution_other",
    clerkUserId: "user_execution_other",
    email: "execution-other@example.com"
  }
] as const;
const manifest: typeof Manifest.Type = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  tier: 2,
  tables: {},
  files: {},
  uses: {},
  handlers: {
    "demo.read": { kind: "query", args: { value: { kind: "number" } }, result: { kind: "json" } },
    "demo.nested": {
      kind: "action",
      args: { value: { kind: "number" } },
      result: { kind: "json" }
    },
    "demo.commit": {
      kind: "mutation",
      args: { value: { kind: "number" } },
      result: { kind: "json" }
    },
    "demo.nestedMutation": {
      kind: "action",
      args: { value: { kind: "number" } },
      result: { kind: "json" }
    }
  }
};

const testServer = (env: Record<string, string> = {}) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "patchy-execution-test-"));
  return Layer.unwrap(
    Effect.gen(function* () {
      let fleetConfig: Record<string, string> = {};
      if (env.EXECUTION_PROVIDER === "local-fleet") {
        const callbackPort = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              const socket = createServer();
              socket.once("error", reject);
              socket.listen(0, "127.0.0.1", () => {
                const address = socket.address();
                if (address === null || typeof address === "string") {
                  socket.close();
                  reject(new Error("Missing callback port"));
                } else socket.close(() => resolve(address.port));
              });
            })
        );
        const resource = yield* LocalTaskProvider.resource({
          callbackUrls: [`http://127.0.0.1:${callbackPort}/callback`]
        });
        fleetConfig = {
          EXECUTION_LOCAL_DIRECTORY: resource.directory,
          EXECUTION_CALLBACK_PORT: String(callbackPort),
          EXECUTION_CALLBACK_URLS: JSON.stringify(resource.callbackUrls)
        };
      }
      return server({ ...env, ...fleetConfig, PATCHY_STORAGE_DIR: directory }).pipe(
        Layer.provideMerge(
          FilesystemContentStore.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: directory }))
            )
          )
        )
      );
    })
  ).pipe(Layer.provide(FetchHttpClient.layer));
};

// Retained historical versions exercise company isolation independently of publication.
const retain = Effect.fn("DevelopmentExecutionTest.retain")(function* (
  fixture: (typeof fixtures)[number],
  withServer = true
) {
  const sql = yield* SqlClient.SqlClient;
  const source = yield* serverSource;
  const key = `patches/${fixture.patchId}/versions/${fixture.versionId}.server.js`;
  if (withServer) yield* (yield* ContentStore.ContentStore).put(key, source);
  yield* sql`INSERT INTO patches
    (id, company_id, owner_user_id, title, name, current_version_id)
    VALUES (${fixture.patchId}, ${fixture.companyId}, ${fixture.userId}, 'Execution fixture',
      ${fixture.patchId}, ${fixture.versionId})`;
  yield* sql`INSERT INTO patch_versions
    (id, patch_id, version_number, object_key, content_hash, file_size,
     server_object_key, server_content_hash, server_file_size,
     created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
     wire_version, schema_revision, manifest, publish_key, payload_digest,
     publish_response, publish_status)
    VALUES (${fixture.versionId}, ${fixture.patchId}, 1, ${`fixture/${fixture.versionId}.html`},
      ${contentHash("")}, 0,
      ${withServer ? key : null}, ${withServer ? sha256(source) : null}, ${withServer ? Buffer.byteLength(source) : null},
      ${DEV_SEED.tokenId}, ${fixture.userId}, 2, ${CURRENT_RELEASE}, 1,
      ${WIRE_VERSION}, 0, ${JSON.stringify(manifest)}::jsonb, ${fixture.versionId}, 'fixture',
      '{}'::jsonb, 201)`;
});

const serverSource = Effect.gen(function* () {
  const built = yield* Effect.promise(() =>
    build({
      stdin: {
        contents: `import { query, mutation, action, createGuest, t } from "patchy/server";
const read = query({
  args: { value: t.number() }, result: t.json(),
  handler: async (ctx, args) => ({
    answer: args.value * 2, viewer: ctx.viewer.user.id, company: ctx.viewer.company.id
  })
});
const nested = action({
  args: { value: t.number() }, result: t.json(),
  handler: async (ctx, args) => ({
    ...await ctx.run.demo.read({ value: args.value + 1 }), via: "action"
  })
});
const commit = mutation({
  args: { value: t.number() }, result: t.json(),
  handler: async (ctx, args) => ({
    answer: args.value * 2, viewer: ctx.viewer.user.id, nonce: crypto.randomUUID()
  })
});
const nestedMutation = action({
  args: { value: t.number() }, result: t.json(),
  handler: async (ctx, args) => ctx.run.demo.commit(args)
});
export default createGuest({ demo: { read, nested, commit, nestedMutation } });`,
        resolveDir: new URL("../../../packages/patchy", import.meta.url).pathname,
        sourcefile: "development-execution-fixture.ts"
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      conditions: ["development"]
    })
  );
  return built.outputFiles[0]!.text;
});

const call = (
  fixture: {
    readonly patchId: string;
    readonly versionId: string;
    readonly userId: string;
    readonly clerkUserId: string;
    readonly email: string;
  },
  handler: string,
  viewer = fixture,
  mutationKey?: string
) =>
  send(
    HttpClientRequest.post("/api/runtime/call").pipe(
      HttpClientRequest.setHeaders({
        origin,
        cookie: signedInCookies(
          signSession({ sub: viewer.clerkUserId, email: viewer.email, azp: origin })
        ),
        "x-patchy-wire": String(WIRE_VERSION),
        "x-patchy-principal": JSON.stringify({ userId: viewer.userId })
      }),
      HttpClientRequest.bodyJsonUnsafe({
        patchId: fixture.patchId,
        versionId: fixture.versionId,
        wire: WIRE_VERSION,
        principal: { userId: viewer.userId },
        op: "server.call",
        args: {
          handler,
          args: { value: 20 },
          ...(mutationKey === undefined ? {} : { mutationKey })
        }
      })
    )
  );

it.layer(testServer({ NODE_ENV: "development" }), { excludeTestServices: true })(
  "the existing dev cloud server",
  (it) => {
    it.effect(
      "executes queries and nested actions on company-isolated workerd with callbacks",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO companies (id, handle, name)
        VALUES (${fixtures[1].companyId}, 'execution-other', 'Other execution company')`;
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${fixtures[1].userId}, ${fixtures[1].clerkUserId}, ${fixtures[1].companyId},
          ${fixtures[1].email}, 'Other viewer', 'member')`;
          for (const fixture of fixtures) {
            yield* retain(fixture);
            assert.deepStrictEqual(yield* answer(yield* call(fixture, "demo.read")), {
              status: 200,
              body: {
                ok: true,
                value: { answer: 40, viewer: fixture.userId, company: fixture.companyId }
              }
            });
            assert.deepStrictEqual(yield* answer(yield* call(fixture, "demo.nested")), {
              status: 200,
              body: {
                ok: true,
                value: {
                  answer: 42,
                  viewer: fixture.userId,
                  company: fixture.companyId,
                  via: "action"
                }
              }
            });
          }
          const denied = yield* call(fixtures[0], "demo.read", fixtures[1]);
          assert.strictEqual(denied.status, 403);
          const tree = yield* sql<{ company_id: string; handler: string; outcome: string }>`
        SELECT child.company_id, child.handler, child.outcome
        FROM runtime_invocations child JOIN runtime_invocations parent ON child.parent_id = parent.id
        WHERE parent.handler = 'demo.nested' ORDER BY child.company_id`;
          assert.deepStrictEqual(
            tree,
            fixtures.map((fixture) => ({
              company_id: fixture.companyId,
              handler: "demo.read",
              outcome: "success"
            }))
          );
          assert.deepStrictEqual(yield* sql`SELECT company_id FROM company_databases`, []);
        }),
      30_000
    );
  }
);

it.layer(testServer({ NODE_ENV: "test" }), { excludeTestServices: true })(
  "mutations through the existing dev cloud server",
  (it) => {
    it.effect(
      "commits a callback-free mutation once per key and admits an action's nested mutation",
      () =>
        Effect.gen(function* () {
          const source = yield* serverSource;
          const response = yield* publish(DEV_SEED.token, {
            html: "<!doctype html><html><body><h1>Mutation</h1></body></html>",
            server: source,
            manifest
          });
          assert.strictEqual(response.status, 201);
          const published = (yield* response.json) as { patchId: string; versionId: string };
          const fixture = { ...fixtures[0], ...published };
          const mutationKey = `${Date.now()}-${randomBytes(16).toString("base64url")}`;
          const committed = yield* answer(
            yield* call(fixture, "demo.commit", fixture, mutationKey)
          );
          assert.strictEqual(committed.status, 200);
          assert.deepInclude(committed.body, { ok: true });
          assert.deepStrictEqual(
            yield* answer(yield* call(fixture, "demo.commit", fixture, mutationKey)),
            committed
          );
          const nested = yield* answer(yield* call(fixture, "demo.nestedMutation"));
          assert.strictEqual(nested.status, 200);
          assert.deepInclude(nested.body, { ok: true });
          const sql = yield* SqlClient.SqlClient;
          const tree = yield* sql<{
            handler: string;
            outcome: string;
            child_ms: number;
            parent_ms: number;
          }>`
          SELECT child.handler, child.outcome, child.db_ms AS child_ms, parent.db_ms AS parent_ms
          FROM runtime_invocations child JOIN runtime_invocations parent ON child.parent_id = parent.id
          WHERE parent.handler = 'demo.nestedMutation'`;
          assert.strictEqual(tree.length, 1);
          assert.strictEqual(tree[0]!.handler, "demo.commit");
          assert.strictEqual(tree[0]!.outcome, "success");
          assert.isAtLeast(tree[0]!.parent_ms, tree[0]!.child_ms);
        }),
      30_000
    );
  }
);

it.layer(testServer({ NODE_ENV: "test", EXECUTION_PROVIDER: "local-fleet" }), {
  excludeTestServices: true
})("fleet-backed cloud server", (it) => {
  it.effect(
    "starts a company task over its document stream and executes nested callbacks on that binding",
    () =>
      Effect.gen(function* () {
        yield* retain(fixtures[0]);
        const fixture = fixtures[0];
        const response = yield* send(
          HttpClientRequest.get("/api/runtime/stream").pipe(
            HttpClientRequest.setUrlParams({
              patchId: fixture.patchId,
              versionId: fixture.versionId,
              documentId: "fleet_starting_document"
            }),
            HttpClientRequest.setHeaders({
              "x-patchy-wire": String(WIRE_VERSION),
              "x-patchy-principal": JSON.stringify({ userId: fixture.userId }),
              "sec-fetch-site": "same-origin",
              cookie: signedInCookies(
                signSession({ sub: fixture.clerkUserId, email: fixture.email, azp: origin })
              )
            })
          )
        );
        assert.strictEqual(response.status, 200);
        const pull = yield* Stream.toPull(response.stream);
        const decoder = new TextDecoder();
        let frames = "";
        while (!frames.includes('"type":"ready"')) {
          for (const bytes of yield* pull) frames += decoder.decode(bytes, { stream: true });
        }
        assert.include(frames, '"type":"starting"');
        assert.deepStrictEqual(yield* answer(yield* call(fixture, "demo.nested")), {
          status: 200,
          body: {
            ok: true,
            value: { answer: 42, viewer: fixture.userId, company: fixture.companyId, via: "action" }
          }
        });
        const mutationKey = `${Date.now()}-${randomBytes(16).toString("base64url")}`;
        const committed = yield* answer(yield* call(fixture, "demo.commit", fixture, mutationKey));
        assert.strictEqual(committed.status, 200);
        assert.deepStrictEqual(
          yield* answer(yield* call(fixture, "demo.commit", fixture, mutationKey)),
          committed
        );
      }).pipe(Effect.scoped),
    60_000
  );
});

it.layer(testServer({ NODE_ENV: "production" }))("production tier 2 admission", (it) => {
  it.effect("refuses publication and never runs a retained bundle on the local executor", () =>
    Effect.gen(function* () {
      const source = yield* serverSource;
      const published = yield* publish(DEV_SEED.token, {
        html: "<html></html>",
        server: source,
        manifest
      });
      assert.strictEqual(published.status, 422);
      assert.deepInclude(yield* published.json, { code: "tier_mismatch" });
      yield* retain(fixtures[0]);
      const response = yield* call(fixtures[0], "demo.read");
      assert.deepStrictEqual(yield* answer(response), {
        status: 503,
        body: Runtime.toFailure(new Runtime.InvocationUnavailable())
      });
    })
  );
});

it.layer(testServer(), { excludeTestServices: true })("dev without retained server bytes", (it) => {
  it.effect("keeps unpublished server bundles explicitly unavailable", () =>
    Effect.gen(function* () {
      yield* retain(fixtures[0], false);
      const response = yield* call(fixtures[0], "demo.read");
      assert.strictEqual(response.status, 503);
      assert.deepInclude(yield* response.json, { ok: false, code: "source_unavailable" });
    })
  );
});
