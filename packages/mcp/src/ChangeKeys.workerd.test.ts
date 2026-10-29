/**
 * `change_patch` onto real workerd, through two doors over one database, each with its own
 * invocation, as two host replicas are: a change logs three calls once, its retry on the other
 * replica answers the first result and writes nothing, a retry whose first result the door never
 * recorded resolves through Runtime's own mutation key, replayed and without writing again, and
 * an action runs once per key.
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { build } from "esbuild";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
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
import { at, call, company, door, harness, objectAt, PRODUCTION, publish } from "./test/door.js";

const source = `import { query, mutation, action, createGuest, t } from "patchy/server";
const logCalls = mutation({description:"Logs calls, one row each.",args:{calls:t.array(t.text())},result:t.json(),handler:async (ctx, args) => {
  for (const note of args.calls) await ctx.tables.calls.insert({note});
  return {logged: args.calls.length};
}});
const sendDigest = action({description:"Sends the digest and logs that it did.",args:{},result:t.json(),handler:async ctx => {
  await ctx.tables.calls.insert({note:"digest sent"});
  return {sent: true};
}});
const countCalls = query({description:"Counts the logged calls.",args:{},result:t.json(),handler:async ctx =>
  (await ctx.tables.calls.list({limit: 100})).rows.length
});
export default createGuest({}, [], { tools: { logCalls, sendDigest, countCalls } });`;

const bundled = Effect.promise(
  async () =>
    (
      await build({
        stdin: {
          contents: source,
          resolveDir: new URL("../../patchy", import.meta.url).pathname,
          sourcefile: "change-patch-fixture.ts"
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

it.layer(services, { excludeTestServices: true, timeout: 90_000 })(
  "change_patch on workerd",
  (it) => {
    it.effect(
      "a change writes once however often it is retried on either replica, and an action runs once",
      () =>
        Effect.gen(function* () {
          const acme = yield* company("change-workerd", [["Priya Shah", "admin"]]);
          const priya = acme.people[0]!;
          const text = yield* bundled;
          const published = yield* publish(acme.id, priya, "call-log", {
            handlers: yield* Inspection.inspect(text),
            tables: {
              calls: { description: "Calls.", columns: { note: { kind: "text" } }, indexes: {} }
            }
          });

          const tables = yield* TableOperations.make;
          const gateway = yield* CallbackGateway.make(tables);
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
          /** One replica: its own invocation and door, over the shared database. */
          const replica = (address: string) =>
            Effect.gen(function* () {
              const invocation = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
                Effect.provideService(Executor.Executor, executor),
                Effect.provideService(ServerBundles.ServerBundles, {
                  load: () => Effect.succeed(bundle)
                })
              );
              return yield* door(PRODUCTION, address).pipe(
                Effect.provideService(Invocation.Invocation, invocation)
              );
            });
          const one = yield* replica("203.0.113.70");
          const two = yield* replica("203.0.113.71");
          type Send = typeof one;
          const answer = (response: { readonly json: unknown; readonly text: string }) => {
            const result = objectAt(response.json, "result");
            assert.isUndefined(result["isError"], response.text);
            return objectAt(result, "structuredContent");
          };
          const change = (send: Send, tool: string, args: unknown, key: string) =>
            send(call(priya.token, "change_patch", { patch: "call-log", tool, args, key }));
          const count = Effect.gen(function* () {
            const read = yield* one(
              call(priya.token, "read_patch", { patch: "call-log", tool: "countCalls", args: {} })
            );
            return answer(read)["result"];
          });
          const log = { calls: ["Ada, renewal", "Grace, new lead", "Linus, churn risk"] };

          // Three calls in one change, under the agent's own key.
          const first = yield* change(one, "logCalls", log, "import-monday");
          assert.deepStrictEqual(answer(first), { result: { logged: 3 }, version: 1 });
          assert.include(first.event, { replayed: false, outcome: "success" });
          assert.strictEqual(yield* count, 3);

          // The retry on the other replica answers the first result and writes nothing.
          const retry = yield* change(two, "logCalls", log, "import-monday");
          assert.deepStrictEqual(answer(retry), {
            result: { logged: 3 },
            version: 1,
            replayed: true
          });
          assert.include(retry.event, { replayed: true });
          assert.strictEqual(yield* count, 3);

          // A first try whose result the door never kept, as when its answer was an unknown
          // outcome: the retry runs under the same mutation key, which Runtime committed once,
          // so Runtime's own record answers it, and it replayed.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE change_keys SET result = NULL WHERE patch_id = ${published.patchId}`;
          const resolved = yield* change(two, "logCalls", log, "import-monday");
          assert.deepStrictEqual(answer(resolved), {
            result: { logged: 3 },
            version: 1,
            replayed: true
          });
          assert.include(resolved.event, { replayed: true });
          assert.strictEqual(yield* count, 3);
          assert.strictEqual(
            answer(yield* change(one, "logCalls", log, "import-monday"))["replayed"],
            true
          );

          // A new key is a new change.
          yield* change(two, "logCalls", { calls: ["Ada, follow-up"] }, "import-tuesday");
          assert.strictEqual(yield* count, 4);

          // An action that writes runs once per key, on either replica.
          assert.deepStrictEqual(answer(yield* change(one, "sendDigest", {}, "digest-1")), {
            result: { sent: true },
            version: 1
          });
          const again = yield* change(two, "sendDigest", {}, "digest-1");
          assert.strictEqual(at(again.json, "result.structuredContent.error.code"), "key_used");
          assert.strictEqual(yield* count, 5);
        }),
      90_000
    );
  }
);
