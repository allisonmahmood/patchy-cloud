/**
 * The log under agents, through the door onto real workerd: the rule is the page's. A query that
 * succeeds without `ctx.log` leaves no row; a query that logs or fails, a read-only action and a
 * change each leave one, naming the person and the agent's client.
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { build } from "esbuild";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as WideEvents from "@patchy/analytics/wide-events";
import type { GuestProtocol } from "@patchy/api";
import { sha256 } from "../../../test/crypto.js";
import * as Inspection from "@patchy/execution/inspection";
import * as Local from "@patchy/execution/local";
import { LoadedVersions } from "@patchy/patches";
import { MutationTransaction, QuerySnapshot, TableOperations } from "@patchy/primitives";
import {
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  RuntimeLog,
  ServerBundles
} from "@patchy/runtime";
import * as TestMemberDirectory from "../../primitives/src/test/memberDirectory.js";
import { at, call, company, door, harness, PRODUCTION, publish } from "./test/door.js";

const source = `import { query, mutation, action, createGuest, t } from "patchy/server";
const countCalls = query({description:"Counts the calls.",args:{},result:t.json(),handler:async ctx =>
  (await ctx.tables.calls.list({limit: 100})).rows.length
});
const countSeen = query({description:"Counts the calls, logging agents' reads.",args:{},result:t.json(),handler:async ctx => {
  if (ctx.agent !== null) ctx.log("read by " + ctx.agent.name);
  return (await ctx.tables.calls.list({limit: 100})).rows.length;
}});
const broken = query({description:"Always throws.",args:{},result:t.json(),handler:async () => {
  throw new Error("broken on purpose");
}});
const peek = action({readOnly:true,description:"Reads the calls.",args:{},result:t.json(),handler:async ctx =>
  (await ctx.tables.calls.list({limit: 100})).rows.length
});
const logCall = mutation({description:"Logs a call.",args:{note:t.text()},result:t.json(),handler:async (ctx, args) => {
  await ctx.tables.calls.insert({note: args.note});
  return {logged: 1};
}});
export default createGuest({}, [], { tools: { countCalls, countSeen, broken, peek, logCall } });`;

const bundled = Effect.promise(
  async () =>
    (
      await build({
        stdin: {
          contents: source,
          resolveDir: new URL("../../patchy", import.meta.url).pathname,
          sourcefile: "log-fixture.ts"
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

const services = Layer.mergeAll(
  InvocationLog.layer,
  RuntimeLog.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer,
  LoadedVersions.layer,
  TestMemberDirectory.layer,
  NodeServices.layer,
  FetchHttpClient.layer
).pipe(Layer.provideMerge(InvocationCapabilities.layer), Layer.provideMerge(harness));

it.layer(services, { excludeTestServices: true, timeout: 90_000 })("the log on workerd", (it) => {
  it.effect(
    "an agent's quiet query leaves no row, and everything else it does is its person's via the agent",
    () =>
      Effect.gen(function* () {
        const acme = yield* company("log-workerd", [["Jordan Lee", "admin"]]);
        const jordan = acme.people[0]!;
        const text = yield* bundled;
        const published = yield* publish(acme.id, jordan, "call-log", {
          handlers: yield* Inspection.inspect(text),
          tables: {
            calls: { description: "Calls.", columns: { note: { kind: "text" } }, indexes: {} }
          }
        });
        const gateway = yield* CallbackGateway.make(yield* TableOperations.make);
        const listener = yield* CallbackGatewayApi.listen().pipe(
          Effect.provideService(CallbackGateway.CallbackGateway, gateway)
        );
        const bundle: GuestProtocol.Bundle = {
          companyId: acme.id,
          patchId: published.patchId,
          versionId: published.versionId,
          sha256: sha256(text),
          bundle: text
        };
        const executor = yield* Local.make({
          companyId: acme.id,
          callbackUrls: [listener.url],
          environment: "test"
        }).pipe(Effect.provide(WideEvents.layerNoop));
        yield* executor.bind(bundle);
        const invocation = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
          Effect.provideService(Executor.Executor, executor),
          Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })
        );
        const send = yield* door(PRODUCTION, "203.0.113.90").pipe(
          Effect.provideService(Invocation.Invocation, invocation)
        );
        const read = (tool: string) =>
          send(call(jordan.token, "read_patch", { patch: "call-log", tool, args: {} }));

        assert.strictEqual(
          at((yield* read("countCalls")).json, "result.structuredContent.result"),
          0
        );
        const changed = yield* send(
          call(jordan.token, "change_patch", {
            patch: "call-log",
            tool: "logCall",
            args: { note: "Ada, renewal" },
            key: "monday"
          })
        );
        assert.deepStrictEqual(at(changed.json, "result.structuredContent.result"), { logged: 1 });
        for (const tool of ["countCalls", "countSeen", "broken", "peek"]) yield* read(tool);

        const { entries } = yield* (yield* InvocationLog.InvocationLog).page({
          companyId: acme.id,
          patchId: published.patchId,
          limit: 100
        });
        assert.deepStrictEqual(
          entries.map(({ invocation }) => [
            invocation.handler,
            invocation.initiatingViewerId,
            invocation.agent,
            invocation.outcome
          ]),
          [
            ["agent.peek", jordan.id, { name: "Claude Code" }, "success"],
            ["agent.broken", jordan.id, { name: "Claude Code" }, "failure"],
            ["agent.countSeen", jordan.id, { name: "Claude Code" }, "success"],
            ["agent.logCall", jordan.id, { name: "Claude Code" }, "success"]
          ]
        );
        const seen = entries.find(({ invocation }) => invocation.handler === "agent.countSeen");
        assert.deepStrictEqual(seen?.invocation.logLines, [{ message: "read by Claude Code" }]);
      }),
    90_000
  );
});
