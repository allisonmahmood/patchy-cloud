import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import { CURRENT_RELEASE, WIRE_VERSION, type Manifest } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { signedInCookies, signSession } from "@patchy/auth/testing";
import { Runtime, ServerBundles } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { answer, send, server } from "./test/server.js";
import { MissingServerBundle } from "./DevelopmentInvocation.js";

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
    "demo.nested": { kind: "action", args: { value: { kind: "number" } }, result: { kind: "json" } }
  }
};

// Publication remains refused. These are already-admitted retained versions and
// the existing bundle data port, not a publishing path or an alternate runtime.
const retain = Effect.fn("DevelopmentExecutionTest.retain")(function* (
  fixture: (typeof fixtures)[number]
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO patches
    (id, company_id, owner_user_id, title, name, current_version_id)
    VALUES (${fixture.patchId}, ${fixture.companyId}, ${fixture.userId}, 'Execution fixture',
      ${fixture.patchId}, ${fixture.versionId})`;
  yield* sql`INSERT INTO patch_versions
    (id, patch_id, version_number, object_key, content_hash, file_size,
     created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
     wire_version, schema_revision, manifest, publish_key, payload_digest,
     publish_response, publish_status)
    VALUES (${fixture.versionId}, ${fixture.patchId}, 1, ${`fixture/${fixture.versionId}.html`},
      'fixture', 0, ${DEV_SEED.tokenId}, ${fixture.userId}, 2, ${CURRENT_RELEASE}, 1,
      ${WIRE_VERSION}, 0, ${JSON.stringify(manifest)}::jsonb, ${fixture.versionId}, 'fixture',
      '{}'::jsonb, 201)`;
});

const bundles = Layer.effect(
  ServerBundles.ServerBundles,
  Effect.gen(function* () {
    const built = yield* Effect.promise(() =>
      build({
        stdin: {
          contents: `import { query, action, createGuest, t } from "patchy/server";
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
export default createGuest({ demo: { read, nested } });`,
          resolveDir: new URL("../../../packages/execution/src", import.meta.url).pathname,
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
    const source = built.outputFiles[0]!.text;
    const sha256 = createHash("sha256").update(source).digest("hex");
    return ServerBundles.ServerBundles.of({
      load: (version) =>
        fixtures.some(
          (fixture) =>
            fixture.companyId === version.companyId &&
            fixture.patchId === version.patchId &&
            fixture.versionId === version.versionId
        )
          ? Effect.succeed({
              companyId: version.companyId,
              patchId: version.patchId,
              versionId: version.versionId,
              sha256,
              bundle: source
            })
          : Effect.fail(
              new Runtime.SourceUnavailable({
                cause: new MissingServerBundle({
                  companyId: version.companyId,
                  patchId: version.patchId,
                  versionId: version.versionId
                })
              })
            )
    });
  })
);

const call = (
  fixture: (typeof fixtures)[number],
  handler: string,
  viewer: (typeof fixtures)[number] = fixture
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
        args: { handler, args: { value: 20 } }
      })
    )
  );

it.layer(
  server({ PATCHY_DEV_EXECUTION: "true", NODE_ENV: "development" }).pipe(Layer.provide(bundles)),
  { excludeTestServices: true }
)("the existing dev cloud server", (it) => {
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
});

for (const env of [{}, { NODE_ENV: "production" }]) {
  it.layer(server(env).pipe(Layer.provide(bundles)))(
    `execution disabled ${env.NODE_ENV ?? "by default"}`,
    (it) => {
      it.effect("does not invoke an eligible bundle without the dev supervisor opt-in", () =>
        Effect.gen(function* () {
          yield* retain(fixtures[0]);
          const response = yield* call(fixtures[0], "demo.read");
          assert.deepStrictEqual(yield* answer(response), {
            status: 503,
            body: Runtime.toFailure(new Runtime.InvocationUnavailable())
          });
        })
      );
    }
  );
}

it.layer(server({ PATCHY_DEV_EXECUTION: "true" }), { excludeTestServices: true })(
  "dev without retained server bytes",
  (it) => {
    it.effect("keeps unpublished server bundles explicitly unavailable", () =>
      Effect.gen(function* () {
        yield* retain(fixtures[0]);
        const response = yield* call(fixtures[0], "demo.read");
        assert.strictEqual(response.status, 503);
        assert.deepInclude(yield* response.json, { ok: false, code: "source_unavailable" });
      })
    );
  }
);

it.effect("refuses opting a production process into local execution", () =>
  Effect.gen(function* () {
    const error = yield* server({ NODE_ENV: "production", PATCHY_DEV_EXECUTION: "true" }).pipe(
      Layer.build,
      Effect.scoped,
      Effect.flip
    );
    assert.deepInclude(error, { _tag: "ExecutionError", reason: "production_refused" });
  })
);
