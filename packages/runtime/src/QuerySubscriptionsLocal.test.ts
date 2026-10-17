import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import {
  CURRENT_RELEASE,
  WIRE_VERSION,
  RuntimeStreamFrame,
  TableRow,
  sharedTableId,
  type GuestProtocol
} from "@patchy/api";
import { newInternalId, sha256 } from "@patchy/core";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import * as Testing from "../../company-database/src/testing.js";
import * as Tables from "../../primitives/src/Tables.js";
import * as TableOperations from "../../primitives/src/TableOperations.js";
import * as QuerySnapshot from "../../primitives/src/QuerySnapshot.js";
import * as MutationTransaction from "../../primitives/src/MutationTransaction.js";
import * as SubscriptionReads from "../../primitives/src/SubscriptionReads.js";
import * as TestWakes from "../../primitives/src/test/wakes.js";
import * as TestMemberDirectory from "../../primitives/src/test/memberDirectory.js";
import * as Local from "../../execution/src/local.js";
import * as Binding from "./Binding.js";
import * as CallbackGateway from "./CallbackGateway.js";
import * as CallbackGatewayApi from "./CallbackGatewayApi.js";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as LoadedVersions from "./LoadedVersions.js";
import { mint } from "./MutationTransaction.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as ServerBundles from "./ServerBundles.js";
import * as StreamLimits from "./StreamLimits.js";
import * as Subscriptions from "./Subscriptions.js";
import * as Wakes from "./Wakes.js";

const row = Schema.decodeUnknownEffect(TableRow);
const decodeFrame = Schema.decodeUnknownSync(RuntimeStreamFrame);
const viewer = {
  user: { id: "usr_dev", name: "Dev", email: "dev@patchy.local" },
  company: { id: "cmp_dev", name: "Patchy Dev", handle: "patchy-dev" },
  admin: true
};
const table = {
  description: "Subscription input",
  columns: { title: { kind: "text" as const } },
  indexes: {}
};
const binding: Binding.Binding["Service"] = {
  patchId: "query403local",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: "cmp_dev",
  wireVersion: WIRE_VERSION,
  scope: "company",
  principal: { userId: viewer.user.id },
  identity: viewer,
  correlationId: "subscription-test",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: { route: table, left: table, right: table },
    files: {},
    uses: {},
    handlers: {
      "demo.live": { kind: "query", args: {}, result: { kind: "text" }, errors: ["held"] },
      "demo.write": {
        kind: "mutation",
        args: { title: { kind: "text" } },
        result: { kind: "text" }
      },
      "demo.badResult": { kind: "query", args: {}, result: { kind: "text" } },
      "demo.action": { kind: "action", args: {}, result: { kind: "text" } }
    }
  }
};
const services = Layer.mergeAll(
  Tables.layer,
  InvocationLog.layer,
  RuntimeLog.layer,
  OperatingLimits.layer,
  Limits.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(TestMemberDirectory.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.some({ ...binding, patchTier: 2 }))
    })
  )
);

it.live(
  "traces changing workerd reads, retains mid-run wakes and recovers business errors through stream frames",
  () =>
    Effect.gen(function* () {
      const platform = yield* SqlClient.SqlClient;
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const tables = yield* Tables.Tables;
      yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name)
      VALUES (${binding.patchId}, 'cmp_dev', 'usr_dev', 'Query subscriptions', 'query-subscriptions')`;
      yield* databases.ensureReady(binding.companyId);
      yield* databases.withCompany(binding.companyId)(
        databases.withPatchLock(binding.patchId)(
          tables.provision(binding.patchId, binding.manifest)
        )
      );
      const handlers = yield* TableOperations.make;
      const call = (op: keyof typeof handlers, args: unknown) =>
        handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
      const route = yield* call("tables.insert", { table: "route", row: { title: "left" } }).pipe(
        Effect.flatMap(row)
      );
      const left = yield* call("tables.insert", { table: "left", row: { title: "same" } }).pipe(
        Effect.flatMap(row)
      );
      const right = yield* call("tables.insert", { table: "right", row: { title: "same" } }).pipe(
        Effect.flatMap(row)
      );
      const gateway = yield* CallbackGateway.make(handlers);
      const reached = yield* Queue.unbounded<void>();
      let gate: Deferred.Deferred<void> | undefined;
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(CallbackGateway.CallbackGateway, {
          callback: (token, attempt, input, charged) =>
            Effect.gen(function* () {
              if (
                input.op === "tables.list" &&
                input.args.table === "right" &&
                gate !== undefined
              ) {
                const waiting = gate;
                gate = undefined;
                yield* Queue.offer(reached, undefined);
                yield* Deferred.await(waiting);
              }
              return yield* gateway.callback(token, attempt, input, charged);
            })
        })
      );
      const source = yield* Effect.promise(
        async () =>
          (
            await build({
              stdin: {
                contents: `import { query, mutation, action, HandlerError, createGuest, t } from "patchy/server";
          const live = query({args:{}, result:t.text(), errors:["held"], handler:async ctx => {
            const route = (await ctx.tables.route.list()).rows[0].title;
            if (route === "held") {
              const current = (await ctx.tables.right.list()).rows[0].title;
              if (current === "released") return current;
              throw new HandlerError("held", {reason:"approval"});
            }
            return (await ctx.tables[route].list()).rows[0].title;
          }});
          const write = mutation({args:{title:t.text()},result:t.text(),handler:async (ctx,args) => {
            const route = (await ctx.tables.route.list()).rows[0];
            await ctx.tables.route.update(route.id,{title:args.title});
            return args.title;
          }});
          const badResult = query({args:{},result:t.text(),handler:async () => 12});
          const outside = action({args:{},result:t.text(),handler:async () => "not a query"});
          export default createGuest({demo:{live,write,badResult,action:outside}});`,
                resolveDir: new URL("../../patchy", import.meta.url).pathname,
                sourcefile: "query-subscription-fixture.ts"
              },
              bundle: true,
              write: false,
              platform: "browser",
              format: "esm",
              target: "es2022",
              conditions: ["development"]
            })
          ).outputFiles[0]!.text
      );
      const bundle: GuestProtocol.Bundle = {
        companyId: binding.companyId,
        patchId: binding.patchId,
        versionId: binding.versionId,
        sha256: sha256(source),
        bundle: source
      };
      const executor = yield* Local.make({
        companyId: binding.companyId,
        callbackUrls: [listener.url],
        environment: "test"
      });
      const invocations = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
        Effect.provideService(Executor.Executor, executor),
        Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })
      );
      const registry = yield* Subscriptions.make.pipe(
        Effect.provideService(Invocation.Invocation, invocations),
        Effect.provide(SubscriptionReads.layer),
        Effect.provide(StreamLimits.layerLocal),
        Effect.provide(WideEvents.layerNoop)
      );
      const frames = yield* Queue.unbounded<RuntimeStreamFrame>();
      const document = registry.attach({
        generation: "generation",
        binding: () => binding,
        check: Effect.void,
        scope: yield* Scope.Scope,
        send: (frame) => {
          Queue.offerUnsafe(frames, decodeFrame(frame));
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(document.close));
      yield* (yield* Wakes.Wakes).subscribe(document.reconcile);
      const next = Queue.take(frames);
      let sequence = 0;
      const subscribe = Effect.fnUntraced(function* (
        id: string,
        handler: string,
        args: Record<string, string> = {}
      ) {
        yield* document.update({
          type: "subscribe",
          patchId: binding.patchId,
          versionId: binding.versionId,
          documentId: "query_document_local",
          generation: "generation",
          sequence: ++sequence,
          subscription: { id, op: "server.call", args: { handler, args } }
        });
        const admitted = yield* Queue.take(frames);
        assert.strictEqual(admitted.type, "admitted");
      });
      yield* subscribe("live", "demo.live");
      const first = yield* next;
      assert.strictEqual(first.type, "snapshot");
      if (first.type !== "snapshot") return;
      assert.strictEqual(first.result, "same");
      assert.deepStrictEqual(Object.keys(first.vector).sort(), [
        "table:query403local:left",
        "table:query403local:route"
      ]);
      yield* call("tables.update", { table: "route", id: route.id, patch: { title: "right" } });
      const equal = yield* next;
      assert.strictEqual(equal.type, "up-to-date");
      if (equal.type !== "up-to-date") return;
      assert.deepStrictEqual(Object.keys(equal.vector).sort(), [
        "table:query403local:right",
        "table:query403local:route"
      ]);
      assert.strictEqual(equal.revision, first.revision);
      yield* call("tables.update", { table: "right", id: right.id, patch: { title: "new" } });
      const changed = yield* next;
      assert.deepInclude(changed, { type: "snapshot", id: "live", result: "new" });
      // A callback for a previously unread resource is held before host observation.
      yield* call("tables.update", { table: "route", id: route.id, patch: { title: "left" } });
      assert.deepInclude(yield* next, { type: "snapshot", result: "same" });
      const release = yield* Deferred.make<void>();
      gate = release;
      yield* call("tables.update", { table: "route", id: route.id, patch: { title: "right" } });
      yield* Queue.take(reached);
      yield* call("tables.update", { table: "right", id: right.id, patch: { title: "mid-run" } });
      yield* Deferred.succeed(release, undefined);
      assert.deepInclude(yield* next, { type: "snapshot", result: "new" });
      assert.deepInclude(yield* next, { type: "snapshot", result: "mid-run" });
      yield* call("tables.update", { table: "route", id: route.id, patch: { title: "left" } });
      assert.deepInclude(yield* next, { type: "snapshot", result: "same" });
      yield* call("tables.update", { table: "route", id: route.id, patch: { title: "held" } });
      const refused = yield* next;
      assert.deepStrictEqual(refused, {
        type: "error",
        id: "live",
        permanent: false,
        error: { ok: false, source: "handler", code: "held", details: { reason: "approval" } }
      });
      // The failed run attempted right but must also retain the previous left dependency.
      yield* call("tables.update", {
        table: "left",
        id: left.id,
        patch: { title: "previous dependency" }
      });
      assert.deepStrictEqual(yield* next, refused);
      // Its new attempted dependency can recover the query without changing the selector.
      yield* call("tables.update", { table: "right", id: right.id, patch: { title: "released" } });
      assert.deepInclude(yield* next, { type: "snapshot", result: "released" });
      yield* call("tables.update", { table: "route", id: route.id, patch: { title: "right" } });
      assert.deepInclude(yield* next, { type: "up-to-date", id: "live" });
      for (const [id, handler, code] of [
        ["mutation", "demo.write", "invalid_request"],
        ["action", "demo.action", "invalid_request"],
        ["removed", "demo.removed", "handler_failed"],
        ["schema", "demo.badResult", "handler_failed"]
      ] as const) {
        yield* subscribe(id, handler, handler === "demo.write" ? { title: "forbidden" } : {});
        const refused = yield* next;
        assert.deepInclude(refused, { type: "error", id, permanent: true });
        if (refused.type === "error") assert.strictEqual(refused.error.code, code);
      }
      yield* call("tables.update", {
        table: "right",
        id: right.id,
        patch: { title: "still-live" }
      });
      assert.deepInclude(yield* next, { type: "snapshot", id: "live", result: "still-live" });
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);

it.live(
  "serves every document of two shared-table patches through sustained writes, which still get connections",
  () =>
    Effect.gen(function* () {
      const platform = yield* SqlClient.SqlClient;
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const tables = yield* Tables.Tables;
      const company = binding.companyId;
      const source: Binding.Binding["Service"] = {
        ...binding,
        patchId: "fairsource",
        manifest: {
          ...binding.manifest,
          tier: 1,
          tables: { notes: { ...table, shared: true } },
          handlers: {}
        }
      };
      // Both readers lease with an authority reserve, and each shared read takes a second connection.
      const reader = (patchId: string, versionId: string): Binding.Binding["Service"] => ({
        ...binding,
        patchId,
        versionId,
        manifest: {
          ...binding.manifest,
          tables: { marks: table },
          uses: {
            notes: {
              kind: "sharedTable",
              patchId: source.patchId,
              table: "notes",
              id: sharedTableId(source.patchId, "notes"),
              revision: 1
            }
          },
          handlers: {
            "demo.count": { kind: "query", args: {}, result: { kind: "text" } },
            "demo.mark": {
              kind: "mutation",
              args: { title: { kind: "text" } },
              result: { kind: "text" }
            }
          }
        }
      });
      const readers = [
        reader("fairalpha", "ver_bbbbbbbbbbbbbbbbbbbbbbbb"),
        reader("fairbeta", "ver_cccccccccccccccccccccccc")
      ];
      yield* databases.ensureReady(company);
      for (const patch of [source, ...readers]) {
        yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES (${patch.patchId}, ${company}, 'usr_dev', ${patch.patchId}, ${patch.patchId})`;
        yield* databases.withCompany(company)(
          databases.withPatchLock(patch.patchId)(tables.provision(patch.patchId, patch.manifest))
        );
      }
      const handlers = yield* TableOperations.make;
      const write = (title: string) =>
        handlers["tables.insert"]
          .run({ table: "notes", row: { title } })
          .pipe(Effect.provideService(Binding.Binding, source));
      const gateway = yield* CallbackGateway.make(handlers);
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const script = yield* Effect.promise(
        async () =>
          (
            await build({
              stdin: {
                contents: `import { query, mutation, createGuest, t } from "patchy/server";
          const count = query({args:{}, result:t.text(), handler:async ctx => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return String((await ctx.shared.notes.list({limit:1000})).rows.length);
          }});
          const mark = mutation({args:{title:t.text()}, result:t.text(), handler:async (ctx,args) =>
            (await ctx.tables.marks.insert({title:args.title})).title});
          export default createGuest({demo:{count,mark}});`,
                resolveDir: new URL("../../patchy", import.meta.url).pathname,
                sourcefile: "subscription-fairness-fixture.ts"
              },
              bundle: true,
              write: false,
              platform: "browser",
              format: "esm",
              target: "es2022",
              conditions: ["development"]
            })
          ).outputFiles[0]!.text
      );
      const executor = yield* Local.make({
        companyId: company,
        callbackUrls: [listener.url],
        environment: "test"
      });
      const invocations = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
        Effect.provideService(Executor.Executor, executor),
        Effect.provideService(ServerBundles.ServerBundles, {
          load: (loaded) =>
            Effect.succeed({
              companyId: loaded.companyId,
              patchId: loaded.patchId,
              versionId: loaded.versionId,
              sha256: sha256(script),
              bundle: script
            })
        })
      );
      // Subscription runs pass an observation; direct mutation calls do not.
      const running = new Map<string, number>();
      const peaks = { company: 0, patch: new Map<string, number>() };
      const tracked = Invocation.Invocation.of({
        call: (args, loaded, reauthorize, observation) =>
          observation === undefined
            ? invocations.call(args, loaded, reauthorize)
            : Effect.sync(() => {
                running.set(loaded.patchId, (running.get(loaded.patchId) ?? 0) + 1);
                const total = [...running.values()].reduce((sum, count) => sum + count, 0);
                peaks.company = Math.max(peaks.company, total);
                peaks.patch.set(
                  loaded.patchId,
                  Math.max(peaks.patch.get(loaded.patchId) ?? 0, running.get(loaded.patchId)!)
                );
              }).pipe(
                Effect.andThen(invocations.call(args, loaded, reauthorize, observation)),
                Effect.ensuring(
                  Effect.sync(() => running.set(loaded.patchId, running.get(loaded.patchId)! - 1))
                )
              )
      });
      const registry = yield* Subscriptions.make.pipe(
        Effect.provideService(Invocation.Invocation, tracked),
        Effect.provide(SubscriptionReads.layer),
        Effect.provide(StreamLimits.layerLocal),
        Effect.provide(WideEvents.layerNoop)
      );
      const wakes = yield* Wakes.Wakes;
      const errors: RuntimeStreamFrame[] = [];
      const documents = yield* Effect.forEach(
        [readers[0]!, readers[0]!, readers[1]!],
        (loaded, index) =>
          Effect.gen(function* () {
            const generation = `fair-${index}`;
            const latest = new Map<string, string>();
            const counts = { snapshots: 0 };
            const document = registry.attach({
              generation,
              binding: () => loaded,
              check: Effect.void,
              scope: yield* Scope.Scope,
              send: (encoded) => {
                const frame = decodeFrame(encoded);
                if (frame.type === "error") errors.push(frame);
                if (frame.type !== "snapshot") return;
                counts.snapshots++;
                latest.set(frame.id, String(frame.result));
              }
            });
            yield* Effect.addFinalizer(() => Effect.sync(document.close));
            yield* wakes.subscribe(document.reconcile);
            yield* document.update({
              type: "replace",
              patchId: loaded.patchId,
              versionId: loaded.versionId,
              documentId: generation,
              generation,
              sequence: 1,
              subscriptions: ["one", "two", "three"].map((id) => ({
                id,
                op: "server.call",
                args: { handler: "demo.count", args: {} }
              }))
            });
            return { loaded, latest, counts };
          })
      );
      // Each round writes the shared table while one patch commits a mutation, faster than
      // nine reads drain through two slots, so every subscription stays dirty.
      const mutate = Effect.fnUntraced(function* (
        loaded: Binding.Binding["Service"],
        title: string
      ) {
        const reply = yield* invocations.call(
          { handler: "demo.mark", args: { title }, mutationKey: yield* mint },
          { ...loaded, correlationId: newInternalId("call") },
          Effect.succeed(viewer)
        );
        assert.deepInclude(reply, { ok: true, value: title });
      });
      let notes = 0;
      const before = documents.map(({ counts }) => counts.snapshots);
      while (documents.some(({ counts }, index) => counts.snapshots - before[index]! < 6)) {
        assert.isBelow(notes, 500, "a document stopped receiving snapshots");
        const round = ++notes;
        yield* Effect.all([write(`note-${round}`), mutate(readers[round % 2]!, `mark-${round}`)], {
          concurrency: "unbounded",
          discard: true
        });
      }
      const settled = (latest: ReadonlyMap<string, string>) =>
        latest.size === 3 && [...latest.values()].every((value) => value === String(notes));
      for (let waited = 0; !documents.every(({ latest }) => settled(latest)); waited += 10) {
        assert.isBelow(waited, 10_000, "a document never saw the last write");
        yield* Effect.sleep("10 millis");
      }
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(peaks.company, 2);
      assert.strictEqual(peaks.patch.get("fairalpha"), 2);
      assert.isAtMost(peaks.patch.get("fairbeta")!, 2);
    }).pipe(Effect.scoped, Effect.provide(services)),
  60_000
);
