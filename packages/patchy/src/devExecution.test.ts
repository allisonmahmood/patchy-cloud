import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { build } from "esbuild";
import { CURRENT_RELEASE, Identity, type RuntimeStreamFrame } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Inspection from "@patchy/execution/inspection";
import { ContractLimits } from "@patchy/limits";
import { Binding, Invocation, Subscriptions } from "@patchy/runtime/dev";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Prepared } from "./devPreparation.js";
import * as DevResources from "./devResources.js";
import type { ServerBinding } from "./devExecution.js";

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
    files: {},
    uses: {}
  },
  metadata: { postgres: {}, shared: {} }
};
const bundle = Effect.fn("test.devBundle")(function* (
  label: string,
  mode: "normal" | "removed" | "breaking" = "normal"
) {
  const source = (yield* Effect.promise(() =>
    build({
      stdin: {
        resolveDir: new URL("..", import.meta.url).pathname,
        sourcefile: "dev-engine-fixture.ts",
        contents: `import { query, mutation, action, createGuest, t } from "patchy/server";
const value = query({args:{},result:t.text(),handler:async () => ${JSON.stringify(label)}});
const live = query({args:${mode === "breaking" ? "{required:t.text()}" : "{}"},result:t.text(),handler:async ctx => {await ctx.tables.notes.list(); return ${JSON.stringify(label)};}});
const nested = action({args:{},result:t.text(),handler:async ctx => {await ctx.tables.notes.list(); return ctx.run.demo.value({});}});
const fixtures = action({args:{},result:t.json(),handler:async ctx => ({viewer:ctx.viewer.user.id, shared:await ctx.shared.contacts.list(), postgres:await ctx.connections.warehouse.query("SELECT marker FROM fixture_marker",[],{marker:t.text()})})});
const write = mutation({args:{title:t.text()},result:t.text(),handler:async (ctx,args) => {await ctx.tables.notes.insert({title:args.title}); ctx.log("saved",{viewer:ctx.viewer.user.id}); return args.title;}});
const fail = mutation({args:{},result:t.text(),handler:async ctx => {await ctx.tables.notes.insert({title:"must roll back"}); throw new Error("dev failure diagnostic");}});
const oversized = query({args:{},result:t.text(),handler:async () => "x".repeat(1000)});
export default createGuest({demo:{value,${mode === "removed" ? "" : "live,"}nested,fixtures,write,fail,oversized}});`
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
      const settlements: Invocation.DevSettlement[] = [];
      const resources = yield* DevResources.prepare(
        {
          ...prepared,
          manifest: { ...prepared.manifest, uses: { contacts: shared, warehouse: postgres } },
          metadata: {
            shared: {
              contacts: {
                declaration: shared,
                tables: { contacts: { ...notes, shared: true } },
                uses: {}
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
          server: yield* bundle("initial"),
          observe: (settlement) =>
            Effect.sync(() => {
              settlements.push(settlement);
            })
        }
      );
      const invocation = Context.get(resources.context, Invocation.Invocation);
      const call = (
        handler: string,
        current = viewer,
        args: Record<string, string> = {},
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
      }
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
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop),
      Effect.provideService(ContractLimits.overrides, { "tier2.query.resultBytes": 128 })
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
        server: initial
      });
      const replace = (input: ServerBinding) =>
        resources.stage(input.bytes).pipe(Effect.flatMap((install) => install(input.handlers)));
      const versionId = resources.version.versionId;
      const invocation = Context.get(resources.context, Invocation.Invocation);
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
      const badBuild = yield* resources
        .stage(new TextEncoder().encode("throw new Error('bad rebuild')"))
        .pipe(Effect.flip);
      assert.strictEqual(badBuild._tag, "ExecutionError");
      assert.deepStrictEqual(yield* call("demo.value"), { ok: true, value: "new" });

      const frames = yield* Queue.unbounded<RuntimeStreamFrame>();
      const registry = Context.get(resources.context, Subscriptions.Subscriptions);
      const document = registry.attach({
        generation: "dev-generation",
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
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(WideEvents.layerNoop)
    ),
  { timeout: 60_000 }
);
