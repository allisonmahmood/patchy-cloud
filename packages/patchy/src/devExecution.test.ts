// @effect-diagnostics nodeBuiltinImport:off -- A stub instance answers on a real socket.
import { createServer } from "node:http";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { build } from "esbuild";
import { CURRENT_RELEASE, Identity, Upload, type RuntimeStreamFrame } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Inspection from "@patchy/execution/inspection";
import { ContractLimits } from "@patchy/limits";
import { Binding, Invocation, Runtime, Subscriptions } from "@patchy/runtime/dev";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { PidgeonDev } from "@patchy/integrations/dev";
import type { Prepared } from "./devPreparation.js";
import * as DevResources from "./devResources.js";
import type { ServerBinding } from "./devExecution.js";
import type { Json } from "./config.js";
import { NodeCryptography } from "@patchy/core";

/** These repos declare no PostHog or Pidgeon connection, so dev never reaches an instance. */
const offline = { instance: { apiUrl: "http://127.0.0.1:1", token: Option.none() } };

const identity = new Identity({
  user: { id: "usr_dev", name: "Builder", email: "dev@patchy.local" },
  company: { id: "cmp_dev", name: "Dev", handle: "dev" },
  role: "admin",
  machine: { id: "machine_dev", name: "Dev machine" }
});
const viewer = { user: identity.user, company: identity.company, admin: true };
const notes = { description: "Notes", columns: { title: { kind: "text" as const } }, indexes: {} };
const prepared: Prepared = {
  patchId: "localdev0000",
  identity,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: { notes },
    files: { documents: { description: "Locally adopted documents" } },
    uses: {}
  },
  metadata: { postgres: {}, posthog: {}, pidgeon: {}, attio: {}, shared: {} }
};
/** A guest built from `contents` against this package's `patchy/server`, and its handlers. */
const compile = Effect.fn("test.devCompile")(function* (contents: string) {
  const source = (yield* Effect.promise(() =>
    build({
      stdin: {
        resolveDir: new URL("..", import.meta.url).pathname,
        sourcefile: "dev-engine-fixture.ts",
        contents
      },
      alias: { "patchy/server": new URL("./server.ts", import.meta.url).pathname },
      external: ["./executeConfig.js"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      conditions: ["development"]
    })
  )).outputFiles[0]!.text;
  return { bytes: new TextEncoder().encode(source), handlers: yield* Inspection.inspect(source) };
});
const bundle = (label: string, mode: "normal" | "removed" | "breaking" = "normal") =>
  compile(`import { query, mutation, action, createGuest, t } from "patchy/server";
const value = query({args:{},result:t.text(),handler:async () => ${JSON.stringify(label)}});
const live = query({args:${mode === "breaking" ? "{required:t.text()}" : "{}"},result:t.text(),handler:async ctx => {await ctx.tables.notes.list(); return ${JSON.stringify(label)};}});
const nested = action({args:{},result:t.text(),handler:async ctx => {await ctx.tables.notes.list(); return ctx.run.demo.value({});}});
const fixtures = action({args:{},result:t.json(),handler:async ctx => ({viewer:ctx.viewer.user.id, shared:await ctx.shared.contacts.list(), postgres:await ctx.connections.warehouse.query("SELECT marker FROM fixture_marker",[],{marker:t.text()})})});
const storeMetadata = query({args:{},result:t.json(),handler:async ctx => ({listed:(await ctx.shared.assets.list()).files.map(file=>file.name),name:(await ctx.shared.assets.stat("nested/brief.txt")).name})});
const storeBytes = action({args:{},result:t.text(),handler:async ctx => new TextDecoder().decode(await ctx.shared.assets.get("nested/brief.txt"))});
const write = mutation({args:{title:t.text()},result:t.text(),handler:async (ctx,args) => {await ctx.tables.notes.insert({title:args.title}); ctx.log("saved",{viewer:ctx.viewer.user.id}); return args.title;}});
const adopt = action({args:{upload:t.upload()},result:t.json(),handler:async (ctx,args) => {
  await ctx.files.documents.put("local.txt",args.upload);
  return {size:args.upload.size,contentType:args.upload.contentType,text:new TextDecoder().decode(await ctx.files.documents.get("local.txt"))};
}});
const fail = mutation({args:{},result:t.text(),handler:async ctx => {await ctx.tables.notes.insert({title:"must roll back"}); throw new Error("dev failure diagnostic");}});
const oversized = query({args:{},result:t.text(),handler:async () => "x".repeat(1000)});
const analytics = action({args:{name:t.text()},result:t.json(),handler:async (ctx,args) => {
  try { return {viewer:ctx.viewer.user.id, rows:(await ctx.connections.analytics.query({name:args.name,query:"SELECT event FROM events LIMIT 10",shape:{event:t.text()}})).rows}; }
  catch (error) { return {code:error.code, correlationId:error.correlationId ?? null}; }
}});
const relayed = action({args:{},result:t.json(),handler:async ctx => (await ctx.connections.analytics.query({name:"broken",query:"SELECT 1",shape:{event:t.text()}})).rows});
export default createGuest({demo:{value,${mode === "removed" ? "" : "live,"}nested,fixtures,storeMetadata,storeBytes,write,adopt,fail,oversized,analytics,relayed}}, ["assets"]);`);

it.live(
  "runs fixture callbacks and transactional writes as each viewer without runtime-log tables",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-dev-engine-fixtures-" });
      yield* fs.makeDirectory(`${root}/fixtures`);
      yield* fs.writeFileString(
        `${root}/fixtures/shared-contacts.sql`,
        "INSERT INTO contacts (id,title) VALUES ('contact-1','Shared fixture');"
      );
      yield* fs.writeFileString(
        `${root}/fixtures/postgres-warehouse.sql`,
        "CREATE TABLE fixture_marker AS SELECT 'Connection fixture'::text AS marker;"
      );
      yield* fs.makeDirectory(`${root}/fixtures/shared-assets/nested`, { recursive: true });
      yield* fs.writeFileString(`${root}/fixtures/shared-assets/README.md`, "Fixture instructions");
      yield* fs.writeFileString(
        `${root}/fixtures/shared-assets/nested/brief.txt`,
        "Shared store fixture"
      );
      const shared = {
        kind: "sharedTable" as const,
        patchId: "source000001",
        table: "contacts",
        id: "source000001/contacts",
        revision: 1
      };
      const postgres = {
        kind: "postgres" as const,
        id: "warehouse",
        handle: "warehouse",
        revision: 1
      };
      const assets = {
        kind: "sharedStore" as const,
        patchId: shared.patchId,
        store: "documents",
        id: `${shared.patchId}/documents`,
        revision: 1
      };
      const settlements: Invocation.DevSettlement[] = [];
      const resources = yield* DevResources.prepare(
        {
          ...prepared,
          manifest: {
            ...prepared.manifest,
            uses: { contacts: shared, assets, warehouse: postgres }
          },
          metadata: {
            posthog: {},
            pidgeon: {},
            attio: {},
            shared: {
              contacts: {
                declaration: shared,
                tables: { contacts: { ...notes, shared: true } },
                uses: {}
              },
              assets: {
                declaration: assets,
                definition: { description: "Source documents", shared: true }
              }
            },
            postgres: {
              warehouse: {
                declaration: postgres,
                snapshot: { version: 1, enums: [], relations: [], exclusions: [] }
              }
            }
          }
        },
        root,
        `${root}/.patchy/dev`,
        {
          ...offline,
          server: yield* bundle("initial"),
          observe: (settlement) =>
            Effect.sync(() => {
              settlements.push(settlement);
            })
        }
      );
      const invocation = Context.getUnsafe(resources.context, Invocation.Invocation);
      const call = (
        handler: string,
        current = viewer,
        args: Record<string, Json> = {},
        mutationKey?: string
      ) =>
        invocation.call(
          { handler, args, ...(mutationKey === undefined ? {} : { mutationKey }) },
          {
            ...resources.version,
            identity: current,
            principal: { userId: current.user.id },
            correlationId: "dev-fixtures"
          },
          Effect.succeed(current)
        );
      const colleague = {
        ...viewer,
        user: { id: "usr_colleague", name: "Colleague", email: "colleague@patchy.local" },
        admin: false
      };
      for (const current of [viewer, colleague]) {
        const reply = yield* call("demo.fixtures", current);
        assert.isTrue(reply.ok);
        if (!reply.ok) return;
        assert.deepInclude(reply.value, { viewer: current.user.id });
        assert.deepNestedInclude(reply.value, {
          "shared.rows[0].title": "Shared fixture",
          "postgres.rows[0].marker": "Connection fixture"
        });
        const metadata = yield* call("demo.storeMetadata", current);
        assert.isTrue(metadata.ok);
        if (metadata.ok) {
          assert.deepStrictEqual(metadata.value, {
            listed: ["nested/brief.txt"],
            name: "nested/brief.txt"
          });
        }
        assert.deepStrictEqual(yield* call("demo.storeBytes", current), {
          ok: true,
          value: "Shared store fixture"
        });
      }
      const staged = yield* resources.handlers["files.stage"]
        .run({ contentType: "text/plain" }, new TextEncoder().encode("Local upload"))
        .pipe(
          Effect.provideService(Binding.Binding, {
            ...resources.version,
            identity: viewer,
            principal: { userId: viewer.user.id },
            correlationId: "local-stage"
          }),
          Effect.flatMap(Schema.decodeUnknownEffect(Upload))
        );
      assert.deepStrictEqual(
        yield* call("demo.adopt", viewer, {
          upload: { ...staged, size: 0, contentType: "image/png" }
        }),
        {
          ok: true,
          value: { size: 12, contentType: "text/plain", text: "Local upload" }
        }
      );
      assert.include(yield* call("demo.adopt", viewer, { upload: staged }).pipe(Effect.flip), {
        code: "not_found"
      });
      const mutationKey = `${Date.now()}-AAAAAAAAAAAAAAAAAAAAAA`;
      assert.include(yield* call("demo.write", colleague, { title: "Kept" }, mutationKey), {
        ok: true,
        value: "Kept"
      });
      const failed = yield* call(
        "demo.fail",
        viewer,
        {},
        `${Date.now()}-BBBBBBBBBBBBBBBBBBBBBB`
      ).pipe(Effect.flip);
      assert.strictEqual(failed.code, "handler_failed");
      assert.include(yield* call("demo.oversized").pipe(Effect.flip), {
        code: "handler_failed",
        limitId: "tier2.query.resultBytes"
      });
      assert.deepStrictEqual(yield* call("demo.value"), { ok: true, value: "initial" });
      const sql = Context.get(resources.context, PgliteClient.PgliteClient);
      assert.deepStrictEqual(yield* sql`SELECT title FROM p_localdev0000.notes`, [
        { title: "Kept" }
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT tablename FROM pg_tables WHERE tablename IN ('runtime_calls', 'runtime_invocations', 'runtime_query_rollups')`,
        []
      );
      assert.deepStrictEqual(
        settlements
          .filter((entry) => entry.handler === "demo.fixtures")
          .map((entry) => entry.initiatingViewerId),
        [viewer.user.id, colleague.user.id]
      );
      assert.include(
        settlements.find((entry) => entry.handler === "demo.write")!,
        { initiatingViewerId: colleague.user.id, outcome: "success" }
      );
      assert.include(
        settlements.find((entry) => entry.handler === "demo.value")!,
        { outcome: "success", callbacks: 0 }
      );
      assert.match(
        JSON.stringify(settlements.find((entry) => entry.handler === "demo.fail")!.logLines),
        /dev failure diagnostic/
      );
    }).pipe(
      Effect.provide([NodeServices.layer, NodeCryptography.layer]),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop),
      Effect.provideService(ContractLimits.overrides, { "tier2.query.resultBytes": 128 })
    ),
  { timeout: 60_000 }
);

it.live(
  "an action reads PostHog through the instance as the machine's person, for either viewer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-dev-posthog-" });
      // The instance's dev door, as far as this repo can tell: it sees the key and the route.
      const seen: Array<{ readonly authorization?: string; readonly body: unknown }> = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                args: { name: string };
              };
              seen.push({
                ...(request.headers.authorization === undefined
                  ? {}
                  : { authorization: request.headers.authorization }),
                body
              });
              const refused = body.args.name === "broken";
              response.writeHead(refused ? 400 : 200, { "content-type": "application/json" });
              response.end(
                JSON.stringify(
                  refused
                    ? {
                        ok: false,
                        source: "patchy",
                        code: "invalid_query",
                        error: "PostHog rejected the query.",
                        details: { message: "Unknown table" },
                        correlationId: "call_on_the_instance"
                      }
                    : { ok: true, value: { ok: true, rows: [{ event: "$pageview" }] } }
                )
              );
            });
          })
        ),
        (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)))
      );
      yield* Effect.callback<void>(
        (resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void))
      );
      const address = server.address();
      if (address === null || typeof address === "string") return assert.fail("Expected TCP");
      const declaration = {
        kind: "posthog" as const,
        id: "conn_product",
        handle: "product",
        revision: 1
      };
      const resources = yield* DevResources.prepare(
        {
          ...prepared,
          manifest: { ...prepared.manifest, uses: { analytics: declaration } },
          metadata: {
            postgres: {},
            shared: {},
            pidgeon: {},
            attio: {},
            posthog: {
              analytics: {
                declaration,
                snapshot: { version: 1, events: [], eventProperties: [], personProperties: [] }
              }
            }
          }
        },
        root,
        `${root}/.patchy/dev`,
        {
          instance: {
            apiUrl: `http://127.0.0.1:${address.port}`,
            token: Option.some(Redacted.make("pp_machine_key"))
          },
          server: yield* bundle("posthog")
        }
      );
      const invocation = Context.getUnsafe(resources.context, Invocation.Invocation);
      const colleague = {
        ...viewer,
        user: { id: "usr_colleague", name: "Colleague", email: "colleague@patchy.local" },
        admin: false
      };
      const call = (name: string, current: typeof viewer) =>
        invocation.call(
          { handler: "demo.analytics", args: { name } },
          {
            ...resources.version,
            identity: current,
            principal: { userId: current.user.id },
            correlationId: "dev-posthog"
          },
          Effect.succeed(current)
        );
      for (const current of [viewer, colleague])
        assert.deepStrictEqual(yield* call("views", current), {
          ok: true,
          value: { viewer: current.user.id, rows: [{ event: "$pageview" }] }
        });
      // A refusal keeps the instance's row, through workerd and back.
      assert.deepStrictEqual(yield* call("broken", viewer), {
        ok: true,
        value: { code: "invalid_query", correlationId: "call_on_the_instance" }
      });
      // An action that relays the refusal hands its caller the operation, as a published one does.
      const relayed = yield* invocation
        .call(
          { handler: "demo.relayed", args: {} },
          {
            ...resources.version,
            identity: viewer,
            principal: { userId: viewer.user.id },
            correlationId: "dev-posthog-relay"
          },
          Effect.succeed(viewer)
        )
        .pipe(Effect.flip);
      assert.deepInclude(Runtime.toFailure(relayed), {
        code: "invalid_query",
        operation: "posthog.query",
        correlationId: "call_on_the_instance"
      });
      assert.deepStrictEqual(
        seen.map((request) => request.authorization),
        [
          "Bearer pp_machine_key",
          "Bearer pp_machine_key",
          "Bearer pp_machine_key",
          "Bearer pp_machine_key"
        ]
      );
      assert.deepStrictEqual(seen[0]!.body, {
        op: "posthog.query",
        connection: { id: "conn_product", handle: "product" },
        args: {
          name: "views",
          query: "SELECT event FROM events LIMIT 10",
          shape: { event: { kind: "text", optional: false } }
        }
      });
    }).pipe(
      Effect.provide([NodeServices.layer, NodeCryptography.layer]),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);

it.live(
  "an action reads Pidgeon through the instance as the machine's person and its reply is simulated, in a repo whose only live integration is Pidgeon",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-dev-pidgeon-" });
      // The instance's dev door, as far as this repo can tell: it sees the key and the route.
      const seen: Array<{ readonly authorization?: string; readonly body: unknown }> = [];
      const thread = {
        id: "thr_1",
        subject: "Where is my order?",
        status: "open",
        from: { email: "sam@customer.example", name: "Sam" },
        preview: "Hi, my order 1043…",
        messageCount: 1,
        hasAttachments: false,
        lastMessageAt: "2026-10-26T09:00:00.000Z",
        createdAt: "2026-10-25T08:00:00.000Z"
      };
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              seen.push({
                ...(request.headers.authorization === undefined
                  ? {}
                  : { authorization: request.headers.authorization }),
                body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
              });
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({ ok: true, value: { threads: [thread], nextCursor: null } })
              );
            });
          })
        ),
        (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)))
      );
      yield* Effect.callback<void>(
        (resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void))
      );
      const address = server.address();
      if (address === null || typeof address === "string") return assert.fail("Expected TCP");
      const declaration = {
        kind: "pidgeon" as const,
        id: "conn_support",
        handle: "support",
        revision: 1
      };
      const simulated: PidgeonDev.Simulated[] = [];
      const resources = yield* DevResources.prepare(
        {
          ...prepared,
          manifest: { ...prepared.manifest, uses: { support: declaration } },
          metadata: {
            postgres: {},
            shared: {},
            posthog: {},
            attio: {},
            pidgeon: {
              support: {
                declaration,
                snapshot: {
                  version: 1,
                  address: {
                    email: "support@acme.example",
                    displayName: null,
                    sendPolicy: "reply_only"
                  },
                  access: "send",
                  test: false,
                  labels: [],
                  plan: "free"
                }
              }
            }
          }
        },
        root,
        `${root}/.patchy/dev`,
        {
          instance: {
            apiUrl: `http://127.0.0.1:${address.port}`,
            token: Option.some(Redacted.make("pp_machine_key"))
          },
          simulated: (write) => Effect.sync(() => void simulated.push(write)),
          server: yield* compile(`import { action, createGuest, t } from "patchy/server";
const answer = action({args:{draft:t.text()},result:t.json(),handler:async (ctx,args) => {
  const inbox = ctx.connections.support;
  const { threads } = await inbox.threads.list({ status: "open" });
  const sent = await inbox.messages.reply("msg_1", { text: "On its way.", idempotencyKey: args.draft });
  return { viewer: ctx.viewer.user.id, threads: threads.map((thread) => thread.id), sent };
}});
export default createGuest({desk:{answer}}, [], {}, ["support"]);`)
        }
      );
      const invocation = Context.getUnsafe(resources.context, Invocation.Invocation);
      const colleague = {
        ...viewer,
        user: { id: "usr_colleague", name: "Colleague", email: "colleague@patchy.local" },
        admin: false
      };
      for (const current of [viewer, colleague]) {
        const answered = yield* invocation.call(
          { handler: "desk.answer", args: { draft: `dev-draft-${current.user.id}` } },
          {
            ...resources.version,
            identity: current,
            principal: { userId: current.user.id },
            correlationId: "dev-pidgeon"
          },
          Effect.succeed(current)
        );
        if (!answered.ok) return assert.fail(JSON.stringify(answered));
        const value = answered.value as {
          viewer: string;
          threads: ReadonlyArray<string>;
          sent: { status: string; messageId: string; test: boolean };
        };
        assert.deepStrictEqual([value.viewer, value.threads], [current.user.id, ["thr_1"]]);
        assert.deepInclude(value.sent, { status: "sent", test: true });
        assert.match(value.sent.messageId, /^dev_/);
      }
      // Each read went to the instance with the key; no reply did, and each shows in dev's output.
      assert.deepStrictEqual(
        seen.map((request) => request.authorization),
        ["Bearer pp_machine_key", "Bearer pp_machine_key"]
      );
      assert.deepStrictEqual(seen[0]!.body, {
        op: "pidgeon.read",
        connection: { id: "conn_support", handle: "support" },
        args: { operation: "threads.list", input: { status: "open" } }
      });
      assert.deepStrictEqual(
        simulated.map((write) => [write.viewerId, write.connection, write.summary]),
        [
          [viewer.user.id, "pidgeon/support", "messages.reply msg_1"],
          [colleague.user.id, "pidgeon/support", "messages.reply msg_1"]
        ]
      );
    }).pipe(
      Effect.provide([NodeServices.layer, NodeCryptography.layer]),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);

it.live(
  "an action reads Attio through the instance as the machine's person, carrying the revision it was generated from",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-dev-attio-" });
      // The instance's dev door, as far as this repo can tell: it sees the key and the route.
      const seen: Array<{ readonly authorization?: string; readonly body: unknown }> = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              seen.push({
                ...(request.headers.authorization === undefined
                  ? {}
                  : { authorization: request.headers.authorization }),
                body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
              });
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  ok: true,
                  value: {
                    ok: true,
                    rows: [
                      {
                        id: "00000000-0000-4000-8000-000000000001",
                        url: "https://app.attio.com/lumen/deals/record/1",
                        createdAt: "2026-10-27T23:49:28.945950775Z",
                        values: { name: "Bikes for Lumen" }
                      }
                    ],
                    cursor: null
                  }
                })
              );
            });
          })
        ),
        (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)))
      );
      yield* Effect.callback<void>(
        (resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void))
      );
      const address = server.address();
      if (address === null || typeof address === "string") return assert.fail("Expected TCP");
      const declaration = { kind: "attio" as const, id: "conn_crm", handle: "crm", revision: 3 };
      const resources = yield* DevResources.prepare(
        {
          ...prepared,
          manifest: { ...prepared.manifest, uses: { crm: declaration } },
          metadata: {
            postgres: {},
            shared: {},
            posthog: {},
            pidgeon: {},
            attio: {
              crm: {
                declaration,
                snapshot: {
                  version: 1,
                  workspace: { id: "ws", name: "Lumen", slug: "lumen" },
                  scopes: ["record_permission:read"],
                  objects: [],
                  lists: [],
                  excluded: []
                }
              }
            }
          }
        },
        root,
        `${root}/.patchy/dev`,
        {
          instance: {
            apiUrl: `http://127.0.0.1:${address.port}`,
            token: Option.some(Redacted.make("pp_machine_key"))
          },
          server: yield* compile(`import { action, createGuest, t } from "patchy/server";
const deals = action({args:{},result:t.json(),handler:async (ctx) => {
  const page = await ctx.connections.crm.objects.deals.list({ eq: { stage: "Lead" }, limit: 5 });
  return { viewer: ctx.viewer.user.id, names: page.rows.map((row) => row.values.name), cursor: page.cursor };
}});
export default createGuest({desk:{deals}}, [], {}, [], ["crm"]);`)
        }
      );
      const invocation = Context.getUnsafe(resources.context, Invocation.Invocation);
      const answered = yield* invocation.call(
        { handler: "desk.deals", args: {} },
        {
          ...resources.version,
          identity: viewer,
          principal: { userId: viewer.user.id },
          correlationId: "dev-attio"
        },
        Effect.succeed(viewer)
      );
      if (!answered.ok) return assert.fail(JSON.stringify(answered));
      assert.deepStrictEqual(answered.value, {
        viewer: viewer.user.id,
        names: ["Bikes for Lumen"],
        cursor: null
      });
      // The read went to the instance with the key and the declaration's revision, alias left behind.
      assert.deepStrictEqual(seen, [
        {
          authorization: "Bearer pp_machine_key",
          body: {
            op: "attio.listRecords",
            connection: { id: "conn_crm", handle: "crm", revision: 3 },
            args: { object: "deals", eq: { stage: "Lead" }, limit: 5 }
          }
        }
      ]);
    }).pipe(
      Effect.provide([NodeServices.layer, NodeCryptography.layer]),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);

it.live(
  "swaps immutable bindings, retains nested work and discards subscription runs crossing a swap",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-dev-rebind-" });
      const initial = yield* bundle("old");
      const next = yield* bundle("new");
      const removed = yield* bundle("removed", "removed");
      const breaking = yield* bundle("breaking", "breaking");
      const resources = yield* DevResources.prepare(prepared, root, `${root}/.patchy/dev`, {
        ...offline,
        server: initial
      });
      // `resources` is typed for every tier; `yield*` keeps both tiers' staging failures.
      const stage = Effect.fn("test.stageServer")(function* (bytes: Uint8Array) {
        return yield* resources.stage(bytes);
      });
      const replace = (input: ServerBinding) =>
        stage(input.bytes).pipe(Effect.flatMap((install) => install(input.handlers)));
      const versionId = resources.version.versionId;
      const invocation = Context.getUnsafe(resources.context, Invocation.Invocation);
      const binding = () =>
        Binding.Binding.of({
          ...resources.version,
          identity: viewer,
          principal: { userId: viewer.user.id },
          correlationId: "dev-rebind"
        });
      const call = (handler: string) =>
        invocation.call({ handler, args: {} }, binding(), Effect.succeed(viewer));
      const reached = yield* Queue.unbounded<void>();
      let hold: Deferred.Deferred<void> | undefined;
      const list = resources.handlers["tables.list"];
      resources.handlers["tables.list"] = {
        ...list,
        run: (args) =>
          Effect.gen(function* () {
            const waiting = hold;
            hold = undefined;
            if (waiting !== undefined) {
              yield* Queue.offer(reached, undefined);
              yield* Deferred.await(waiting);
            }
            return yield* list.run(args);
          })
      };
      const releaseAction = yield* Deferred.make<void>();
      hold = releaseAction;
      const admitted = yield* call("demo.nested").pipe(Effect.forkScoped);
      yield* Queue.take(reached);
      const installNext = yield* resources.stage(next.bytes);
      assert.deepStrictEqual(yield* call("demo.value"), { ok: true, value: "old" });
      yield* installNext(next.handlers);
      assert.strictEqual(resources.version.versionId, versionId);
      assert.deepStrictEqual(yield* call("demo.value"), { ok: true, value: "new" });
      yield* Deferred.succeed(releaseAction, undefined);
      assert.deepStrictEqual(yield* Fiber.join(admitted), { ok: true, value: "old" });
      const badBuild = yield* stage(
        new TextEncoder().encode("throw new Error('bad rebuild')")
      ).pipe(Effect.flip);
      assert.strictEqual(badBuild._tag, "ExecutionError");
      assert.deepStrictEqual(yield* call("demo.value"), { ok: true, value: "new" });

      const frames = yield* Queue.unbounded<RuntimeStreamFrame>();
      const registry = Context.get(resources.context, Subscriptions.Subscriptions);
      const document = registry.attach({
        generation: "dev-generation",
        documentId: "dev_execution_document",
        binding,
        check: Effect.void,
        scope: yield* Scope.Scope,
        send: (frame) => {
          Queue.offerUnsafe(frames, frame);
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(document.close));
      let sequence = 0;
      const subscribe = (id: string) =>
        document.update({
          type: "subscribe",
          patchId: prepared.patchId,
          versionId,
          documentId: "dev-document",
          generation: "dev-generation",
          sequence: ++sequence,
          subscription: { id, op: "server.call", args: { handler: "demo.live", args: {} } }
        });
      const releaseQuery = yield* Deferred.make<void>();
      hold = releaseQuery;
      yield* subscribe("live");
      assert.strictEqual((yield* Queue.take(frames)).type, "admitted");
      yield* Queue.take(reached);
      yield* replace(initial);
      assert.strictEqual((yield* Queue.take(frames)).type, "handlers");
      yield* Deferred.succeed(releaseQuery, undefined);
      const fresh = yield* Queue.take(frames);
      assert.include(fresh, { type: "snapshot", id: "live", result: "old" });
      yield* replace(next);
      assert.strictEqual((yield* Queue.take(frames)).type, "handlers");
      assert.include(yield* Queue.take(frames), { type: "snapshot", id: "live", result: "new" });
      yield* replace(removed);
      const removedKinds = yield* Queue.take(frames);
      assert.strictEqual(removedKinds.type, "handlers");
      if (removedKinds.type !== "handlers") return;
      assert.notProperty(removedKinds.kinds, "demo.live");
      assert.strictEqual(removedKinds.kinds["demo.write"], "mutation");
      assert.deepInclude(yield* Queue.take(frames), { type: "error", id: "live", permanent: true });
      yield* replace(initial);
      assert.strictEqual((yield* Queue.take(frames)).type, "handlers");
      yield* subscribe("args");
      assert.strictEqual((yield* Queue.take(frames)).type, "admitted");
      assert.include(yield* Queue.take(frames), { type: "snapshot", id: "args", result: "old" });
      yield* replace(breaking);
      assert.strictEqual((yield* Queue.take(frames)).type, "handlers");
      assert.deepInclude(yield* Queue.take(frames), { type: "error", id: "args", permanent: true });
      yield* replace(initial);
      assert.strictEqual((yield* Queue.take(frames)).type, "handlers");
      yield* subscribe("healthy");
      assert.strictEqual((yield* Queue.take(frames)).type, "admitted");
      assert.include(yield* Queue.take(frames), { type: "snapshot", id: "healthy", result: "old" });
      assert.strictEqual((yield* Queue.poll(frames))._tag, "None");
    }).pipe(
      Effect.provide([NodeServices.layer, NodeCryptography.layer]),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);
