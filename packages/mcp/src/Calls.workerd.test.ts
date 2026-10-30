/**
 * `read_patch` through the door onto real workerd: an agent's read runs its tool as the person,
 * reading its own table, a shared table and a company Postgres connection through the same
 * callbacks a page's calls use. The read-only guarantees, the shared table's live check, the
 * person's authority over the connection and the recheck that stops a call whose connection
 * ended all hold for an agent as for a page.
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { build } from "esbuild";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as WideEvents from "@patchy/analytics/wide-events";
import { type GuestProtocol, sharedTableId, type RuntimeMe } from "@patchy/api";
import { AgentConnections } from "@patchy/auth";
import { sha256 } from "../../../test/crypto.js";
import * as Inspection from "@patchy/execution/inspection";
import * as Local from "@patchy/execution/local";
import { ConnectionStore, PostgresExecution, PostgresOperations } from "@patchy/integrations";
import { LoadedVersions, Patches } from "@patchy/patches";
import { MutationTransaction, QuerySnapshot, TableOperations } from "@patchy/primitives";
import {
  Binding,
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
import { nativeExecution } from "../../integrations/src/test/nativeExecution.js";
import {
  at,
  call,
  company,
  door,
  harnessWith,
  objectAt,
  PRODUCTION,
  publish,
  type Person
} from "./test/door.js";

const warehouse = { kind: "postgres" as const, id: "con_door_warehouse", handle: "warehouse" };

/** The company's Postgres connection, read through native execution of this block's database. */
const connection = (companyId: string) => ({
  connection: {
    id: warehouse.id,
    companyId,
    integration: "postgres" as const,
    handle: warehouse.handle,
    description: "The sales warehouse.",
    mode: "company" as const,
    status: "connected" as const,
    credentialRevision: 1,
    metadataRevision: 1,
    display: { host: "warehouse.invalid", port: 5432, database: "warehouse", role: "reader" },
    lastTestedAt: null,
    lastDiscoveredAt: null,
    createdBy: "usr_door_workerd_0"
  },
  snapshots: [
    {
      revision: 1,
      metadata: {
        integration: "postgres" as const,
        snapshot: { version: 1 as const, enums: [], exclusions: [], relations: [] }
      }
    }
  ]
});

// Every tool is a read: a query, then read-only actions, three of which push past their types.
const source = `import { query, action, createGuest, t } from "patchy/server";
const listDeals = query({description:"Deals, the accounts they belong to, and who asked.",args:{},result:t.json(),handler:async ctx => ({
  viewer: ctx.viewer.user.id,
  agent: ctx.agent,
  deals: (await ctx.tables.deals.list()).rows.map(row => row.name),
  accounts: (await ctx.shared.accounts.list()).rows.map(row => row.name).sort()
})});
const leads = action({readOnly:true,description:"Leads from the warehouse.",args:{},result:t.json(),handler:async ctx =>
  (await ctx.connections.warehouse.query("SELECT id, name FROM public.door_leads ORDER BY id", [], {id:t.integer(),name:t.text()})).rows
});
const forceInsert = action({readOnly:true,description:"Tries to write the warehouse.",args:{},result:t.json(),handler:async ctx =>
  ctx.connections.warehouse.query("INSERT INTO public.door_leads VALUES (3, 'Forced') RETURNING id", [], {id:t.integer()})
});
const forceRow = action({readOnly:true,description:"Tries to add a deal.",args:{},result:t.json(),handler:async ctx =>
  ctx.tables.deals.insert({name:"Forced"})
});
const slow = action({readOnly:true,description:"Reads the accounts, waits, then the warehouse.",args:{},result:t.json(),handler:async ctx => {
  const first = (await ctx.shared.accounts.list()).rows.length;
  const waiting = Promise.withResolvers();
  setTimeout(waiting.resolve, 2000);
  await waiting.promise;
  try {
    await ctx.connections.warehouse.query("SELECT 1 AS one", [], {one:t.integer()});
    return {first, second:"ran"};
  } catch (error) {
    return {first, second:error.code};
  }
}});
export default createGuest({}, [], { tools: { listDeals, leads, forceInsert, forceRow, slow } });`;

const bundled = Effect.promise(
  async () =>
    (
      await build({
        stdin: {
          contents: source,
          resolveDir: new URL("../../patchy", import.meta.url).pathname,
          sourcefile: "read-patch-fixture.ts"
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
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(harnessWith([connection("cmp_door_workerd")]))
);

it.layer(services, { excludeTestServices: true, timeout: 90_000 })(
  "read_patch on workerd",
  (it) => {
    it.effect(
      "an agent reads as its person, and Patchy's read-only, shared-table and connection rules hold",
      () =>
        Effect.gen(function* () {
          const acme = yield* company("workerd", [
            ["Priya Shah", "admin"],
            ["Ben Okafor", "member"]
          ]);
          const [priya, ben] = acme.people as [Person, Person];
          const sql = yield* SqlClient.SqlClient;
          // The warehouse is this block's own database, as nativeExecution reads it.
          yield* sql`CREATE TABLE public.door_leads (id integer PRIMARY KEY, name text NOT NULL)`;
          yield* sql`INSERT INTO public.door_leads VALUES (1, 'Ada'), (2, 'Grace')`;

          const patches = yield* Patches.Patches;
          const tables = yield* TableOperations.make;
          /** Inserts `rows` into a patch's own table, as `person` calling it. */
          const insert = (patchId: string, table: string, person: Person, rows: string[]) =>
            Effect.gen(function* () {
              const found = yield* patches.find(patchId);
              const version = LoadedVersions.loaded(Option.getOrThrow(found));
              const identity: NonNullable<RuntimeMe> = {
                user: { id: person.id, name: person.name, email: person.email },
                company: { id: acme.id, handle: acme.handle, name: acme.name },
                admin: person.role === "admin",
                guest: false
              };
              for (const name of rows)
                yield* tables["tables.insert"].run({ table, row: { name } }).pipe(
                  Effect.provideService(
                    Binding.Binding,
                    Binding.Binding.of({
                      ...version,
                      identity,
                      principal: { userId: person.id },
                      correlationId: `seed-${name}`
                    })
                  )
                );
            });

          const accounts = yield* publish(acme.id, priya, "accounts", {
            handlers: {},
            tables: {
              accounts: {
                description: "Client accounts.",
                columns: { name: { kind: "text" } },
                indexes: {},
                shared: true
              }
            }
          });
          yield* insert(accounts.patchId, "accounts", priya, ["Initech", "Globex"]);

          const text = yield* bundled;
          const handlers = yield* Inspection.inspect(text);
          const deals = yield* publish(acme.id, priya, "new-business", {
            handlers,
            tables: {
              deals: { description: "Deals.", columns: { name: { kind: "text" } }, indexes: {} }
            },
            uses: {
              accounts: {
                kind: "sharedTable",
                patchId: accounts.patchId,
                table: "accounts",
                id: sharedTableId(accounts.patchId, "accounts"),
                revision: 1
              },
              warehouse: { ...warehouse, revision: 1 }
            }
          });
          yield* insert(deals.patchId, "deals", priya, ["Renewal"]);

          // Each read of the shared table, so a test can wait for a call to have made one.
          const listed = yield* Queue.unbounded<void>();
          const execution = yield* nativeExecution(yield* ConnectionStore.ConnectionStore);
          const gateway = yield* CallbackGateway.make({
            ...tables,
            ...(yield* PostgresOperations.makeHandlers.pipe(
              Effect.provideService(PostgresExecution.Execution, execution)
            )),
            "shared.list": {
              ...tables["shared.list"],
              run: (args) =>
                tables["shared.list"]
                  .run(args)
                  .pipe(Effect.tap(() => Queue.offer(listed, undefined)))
            }
          });
          const listener = yield* CallbackGatewayApi.listen().pipe(
            Effect.provideService(CallbackGateway.CallbackGateway, gateway)
          );
          const bundle: GuestProtocol.Bundle = {
            companyId: acme.id,
            patchId: deals.patchId,
            versionId: deals.versionId,
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
            Effect.provideService(ServerBundles.ServerBundles, {
              load: () => Effect.succeed(bundle)
            })
          );
          const send = yield* door(PRODUCTION, "203.0.113.50").pipe(
            Effect.provideService(Invocation.Invocation, invocation)
          );
          const read = (person: Person, tool: string) =>
            send(call(person.token, "read_patch", { patch: "new-business", tool, args: {} }));
          const result = (response: { readonly json: unknown; readonly text: string }) => {
            const answered = objectAt(response.json, "result");
            assert.isUndefined(answered["isError"], response.text);
            return at(answered, "structuredContent.result");
          };
          const refusal = (response: { readonly json: unknown }) =>
            objectAt(response.json, "result.structuredContent.error");

          // The person, through their agent: their own rows, the shared table's and its name.
          const first = yield* read(ben, "listDeals");
          assert.deepStrictEqual(result(first), {
            viewer: ben.id,
            agent: { name: "Claude Code" },
            deals: ["Renewal"],
            accounts: ["Globex", "Initech"]
          });
          // Its event: the door's tool and the patch's, and how long it queued, ran and read.
          assert.include(first.event, {
            mcpTool: "read_patch",
            agentTool: "listDeals",
            agentToolKind: "read",
            handler: "agent.listDeals",
            kind: "query",
            outcome: "success"
          });
          for (const field of ["queueWaitMs", "guestMs", "dbMs"])
            assert.isNumber(at(first.event, field), field);

          // A read-only action reads the connection as the person, logged as them via the agent.
          assert.deepStrictEqual(result(yield* read(ben, "leads")), [
            { id: 1, name: "Ada" },
            { id: 2, name: "Grace" }
          ]);
          const [logged] = yield* (yield* RuntimeLog.RuntimeLog).recent({
            companyId: acme.id,
            connectionId: warehouse.id
          });
          assert.include(logged, { userId: ben.id, outcome: "success" });

          // Writes forced past a read's types are refused, in Postgres and in the patch's tables.
          const forced = refusal(yield* read(ben, "forceInsert"));
          assert.strictEqual(forced["code"], "invalid_query");
          assert.strictEqual(at(forced, "details.sqlstate"), "25006");
          assert.deepStrictEqual(
            (yield* sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM public.door_leads`)[0],
            { count: 2 }
          );
          assert.deepStrictEqual(refusal(yield* read(ben, "forceRow")), {
            code: "access_denied",
            from: "patchy",
            message: "A read-only action cannot write."
          });

          // The shared table's live check: its source retired, the whole read is refused.
          yield* patches.retire(accounts.patchId, { userId: priya.id, admin: true }, true);
          assert.strictEqual(refusal(yield* read(ben, "listDeals"))["code"], "access_denied");
          yield* patches.restore(accounts.patchId, { userId: priya.id, admin: true });
          assert.deepInclude(result(yield* read(ben, "listDeals")), {
            accounts: ["Globex", "Initech"]
          });

          // Ended mid-call: the call's next company callback is refused, and the next call 401s.
          yield* Queue.clear(listed);
          const slow = yield* Effect.forkChild(read(ben, "slow"));
          yield* Queue.take(listed);
          yield* AgentConnections.AgentConnections.use((connections) =>
            connections.disconnect({ id: ben.connectionId, userId: ben.id })
          );
          assert.deepStrictEqual(result(yield* Fiber.join(slow)), {
            first: 2,
            second: "access_denied"
          });
          assert.strictEqual((yield* read(ben, "listDeals")).status, 401);
        }),
      90_000
    );
  }
);
