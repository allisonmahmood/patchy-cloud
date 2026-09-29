import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import { CURRENT_RELEASE, TablePage, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import { sha256 } from "@patchy/core";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import * as Testing from "../../company-database/src/testing.js";
import * as Tables from "../../primitives/src/Tables.js";
import * as TableOperations from "../../primitives/src/TableOperations.js";
import * as QuerySnapshot from "../../primitives/src/QuerySnapshot.js";
import * as TestWakes from "../../primitives/src/test/wakes.js";
import * as Local from "../../execution/src/local.js";
import * as Binding from "./Binding.js";
import * as CallbackGateway from "./CallbackGateway.js";
import * as CallbackGatewayApi from "./CallbackGatewayApi.js";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as ServerBundles from "./ServerBundles.js";

const viewer = {
  user: { id: "usr_dev", name: "Dev", email: "dev@patchy.local" },
  company: { id: "cmp_dev", name: "Patchy Dev", handle: "patchy-dev" },
  admin: true
};
const binding: Binding.Binding["Service"] = {
  patchId: "local3970001",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: "cmp_dev",
  wireVersion: WIRE_VERSION,
  scope: "company",
  identity: viewer,
  principal: { userId: "usr_dev" },
  correlationId: "setup",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: { notes: { description: "Notes", columns: { title: { kind: "text" } }, indexes: {} } },
    files: {},
    uses: {},
    handlers: {
      "demo.read": { kind: "query", args: {}, result: { kind: "json" } },
      "demo.fail": { kind: "query", args: {}, result: { kind: "json" } },
      "demo.queryTimeout": { kind: "query", args: {}, result: { kind: "json" } },
      "demo.write": { kind: "action", args: {}, result: { kind: "json" } },
      "demo.nested": { kind: "action", args: {}, result: { kind: "json" } },
      "demo.forbidden": { kind: "action", args: {}, result: { kind: "json" } },
      "demo.writeThenTimeout": { kind: "action", args: {}, result: { kind: "json" } }
    }
  }
};
const services = Layer.mergeAll(
  Tables.layer,
  InvocationLog.layer,
  RuntimeLog.layer,
  OperatingLimits.layer,
  Limits.layer,
  QuerySnapshot.layer
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(Layer.succeed(ContractLimits.overrides, { "tier2.action.deadline": 2_000 })),
  Layer.provideMerge(
    Layer.succeed(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.some(binding))
    })
  )
);

it.live(
  "keeps handler diagnostics private and partial-write outcomes truthful on supervised workerd",
  () =>
    Effect.gen(function* () {
      const platform = yield* SqlClient.SqlClient;
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const tables = yield* Tables.Tables;
      yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name) VALUES (${binding.patchId}, 'cmp_dev', 'usr_dev', 'Invocation', 'invocation-local')`;
      yield* databases.ensureReady(binding.companyId);
      yield* platform.withTransaction(
        Effect.gen(function* () {
          yield* platform`SELECT id FROM patches WHERE id = ${binding.patchId} FOR UPDATE`;
          yield* databases.withCompany(binding.companyId)(
            databases.withPatchLock(binding.patchId)(
              tables.provision(binding.patchId, binding.manifest)
            )
          );
        })
      );
      const handlers = yield* TableOperations.make;
      yield* handlers["tables.insert"]
        .run({ table: "notes", row: { title: "Gateway proof" } })
        .pipe(Effect.provideService(Binding.Binding, binding));
      const gateway = yield* CallbackGateway.make(handlers);
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const source = yield* Effect.promise(
        async () =>
          (
            await build({
              stdin: {
                contents: `import { query, action, createGuest, t } from "patchy/server";
      const read = query({args:{},result:t.json(),handler:async ctx => { ctx.log("Reading own notes"); return {viewer:ctx.viewer.user.id, page:await ctx.tables.notes.list()}; }});
      const fail = query({args:{},result:t.json(),handler:async () => { throw new Error("private diagnostic 397"); }});
      const write = action({args:{},result:t.json(),handler:async ctx => await ctx.tables.notes.insert({title:"Attributed write"})});
      const nested = action({args:{},result:t.json(),handler:async ctx => ctx.run.demo.read({})});
      const forbidden = action({args:{},result:t.json(),handler:async ctx => ctx.run.demo.write({})});
      const queryTimeout = query({args:{},result:t.json(),handler:async ctx => {
        await ctx.tables.notes.list();
        // The separate workerd process does not share the host's TestClock.
        const waiting = Promise.withResolvers();
        setTimeout(waiting.resolve, 60_000);
        await waiting.promise;
        return null;
      }});
      const writeThenTimeout = action({args:{},result:t.json(),handler:async ctx => {
        await ctx.tables.notes.insert({title:"Committed before deadline"});
        // This guest runs in a separate workerd process, outside the host TestClock.
        const waiting = Promise.withResolvers();
        setTimeout(waiting.resolve, 60_000);
        await waiting.promise;
        return null;
      }});
      export default createGuest({demo:{read,fail,write,nested,forbidden,queryTimeout,writeThenTimeout}});`,
                resolveDir: new URL("../../execution/src", import.meta.url).pathname,
                sourcefile: "invocation-fixture.ts"
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
      const runtime = yield* Runtime.make(handlers, {
        origin: "http://localhost",
        identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
      }).pipe(Effect.provideService(Invocation.Invocation, invocations));
      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost/api/runtime/call", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "x-patchy-wire": "1",
            "x-patchy-principal": JSON.stringify(binding.principal)
          }
        })
      );
      const call = (handler: string) =>
        runtime
          .call({
            patchId: binding.patchId,
            versionId: binding.versionId,
            wire: 1,
            principal: binding.principal,
            op: "server.call",
            args: { handler, args: {} }
          })
          .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
      const read = yield* call("demo.read").pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({ viewer: Schema.String, page: TablePage })
            })
          )
        )
      );
      assert.strictEqual(read.value.viewer, "usr_dev");
      assert.deepStrictEqual(
        read.value.page.rows.map((row) => row.title),
        ["Gateway proof"]
      );
      assert.isNull(read.value.page.cursor);
      assert.deepStrictEqual(yield* call("demo.nested"), read);
      const tree = yield* platform<{
        parent_handler: string;
        child_handler: string;
        child_outcome: string;
      }>`SELECT parent.handler AS parent_handler, child.handler AS child_handler,
          child.outcome AS child_outcome
        FROM runtime_invocations child JOIN runtime_invocations parent ON child.parent_id = parent.id
        WHERE parent.patch_id = ${binding.patchId}`;
      assert.deepStrictEqual(tree, [
        {
          parent_handler: "demo.nested",
          child_handler: "demo.read",
          child_outcome: "success"
        }
      ]);
      assert.strictEqual((yield* call("demo.forbidden").pipe(Effect.flip)).code, "access_denied");
      const written = yield* call("demo.write");
      assert.deepInclude(written, { ok: true });
      const rows = yield* platform<{
        user_id: string | null;
        effective_principal: string;
        invocation_id: string;
      }>`SELECT user_id, effective_principal, invocation_id FROM runtime_calls WHERE patch_id = ${binding.patchId} AND op = 'tables.insert'`;
      assert.strictEqual(rows[0]?.user_id, null);
      assert.strictEqual(rows[0]?.effective_principal, "patch");
      const log = yield* InvocationLog.InvocationLog;
      assert.strictEqual(
        (yield* log.find({ companyId: binding.companyId, invocationId: rows[0]!.invocation_id }))
          ?.outcome,
        "success"
      );
      const failure = yield* call("demo.fail").pipe(Effect.flip);
      assert.strictEqual(failure.code, "handler_failed");
      assert.notInclude(JSON.stringify(Runtime.toFailure(failure)), "private diagnostic 397");
      const diagnostics = yield* platform<{
        log_lines: unknown;
      }>`SELECT log_lines FROM runtime_invocations WHERE correlation_id = ${failure.correlationId!}`;
      assert.include(JSON.stringify(diagnostics[0]?.log_lines), "private diagnostic 397");
      assert.include(JSON.stringify(diagnostics[0]?.log_lines), "stack");
      const queryTimeout = yield* call("demo.queryTimeout").pipe(Effect.flip);
      assert.strictEqual(queryTimeout.code, "handler_timeout");
      assert.include(JSON.stringify(yield* call("demo.read")), "Attributed write");
      const uncertain = yield* call("demo.writeThenTimeout").pipe(Effect.flip);
      assert.strictEqual(uncertain.code, "unknown_outcome");
      const page = yield* handlers["tables.list"]
        .run({ table: "notes" })
        .pipe(
          Effect.provideService(Binding.Binding, binding),
          Effect.flatMap(Schema.decodeUnknownEffect(TablePage))
        );
      assert.include(
        page.rows.map((row) => row.title),
        "Committed before deadline"
      );
      const outcomes = yield* platform<{ outcome: string }>`
        SELECT outcome FROM runtime_invocations WHERE correlation_id = ${uncertain.correlationId!}
      `;
      assert.strictEqual(outcomes[0]?.outcome, "unknown_outcome");
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);
