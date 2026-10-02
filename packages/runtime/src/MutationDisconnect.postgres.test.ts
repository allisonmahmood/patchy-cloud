import { randomBytes } from "node:crypto";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import { newInternalId } from "@patchy/core";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import * as Testing from "../../company-database/src/testing.js";
import * as Tables from "../../primitives/src/Tables.js";
import * as TableOperations from "../../primitives/src/TableOperations.js";
import * as QuerySnapshot from "../../primitives/src/QuerySnapshot.js";
import * as MutationTransaction from "../../primitives/src/MutationTransaction.js";
import * as TestWakes from "../../primitives/src/test/wakes.js";
import * as TestMemberDirectory from "../../primitives/src/test/memberDirectory.js";
import * as Binding from "./Binding.js";
import * as CallbackGateway from "./CallbackGateway.js";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as ServerBundles from "./ServerBundles.js";

const viewer = {
  user: { id: "usr_dev", name: "Dev", email: "dev@patchy.local" },
  company: { id: "cmp_dev", name: "Patchy Dev", handle: "patchy-dev" },
  admin: true
};
const binding: Binding.Binding["Service"] = {
  patchId: "drop40000001",
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
      "drop.query": { kind: "query", args: {}, result: { kind: "json" } },
      "drop.mutation": { kind: "mutation", args: {}, result: { kind: "json" } },
      "drop.action": { kind: "action", args: {}, result: { kind: "json" } },
      "drop.probe": { kind: "query", args: {}, result: { kind: "json" } },
      "drop.commit": { kind: "mutation", args: {}, result: { kind: "json" } },
      "drop.nested": { kind: "action", args: {}, result: { kind: "json" } }
    }
  }
};
const bundle: GuestProtocol.Bundle = {
  companyId: binding.companyId,
  patchId: binding.patchId,
  versionId: binding.versionId,
  sha256: "0".repeat(64),
  bundle: "disconnect-fault-executor"
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
  Layer.provideMerge(
    Layer.succeed(ContractLimits.overrides, {
      "tier2.query.deadline": 1_000,
      "tier2.mutation.deadline": 1_000,
      "tier2.action.deadline": 1_000,
      "tier2.settlement.cleanup": 1_000
    })
  ),
  Layer.provideMerge(
    Layer.succeed(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.some({ ...binding, patchTier: binding.manifest.tier }))
    })
  )
);

const prepare = Effect.gen(function* () {
  const platform = yield* SqlClient.SqlClient;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name)
    VALUES (${binding.patchId}, 'cmp_dev', 'usr_dev', 'Dropped callers', 'dropped-callers')`;
  const placement = yield* databases.ensureReady(binding.companyId);
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
  return placement;
});

const host = Effect.gen(function* () {
  const handlers = yield* TableOperations.make;
  const gateway = yield* CallbackGateway.make(handlers);
  const opened = yield* Queue.unbounded<GuestProtocol.Invoke>();
  const invoke: Executor.Executor["Service"]["invoke"] = (request) =>
    Effect.gen(function* () {
      if (request.handler === "drop.action" || request.handler === "drop.nested") {
        const reply = yield* gateway.callback(request.callback.capability, request, {
          op: "server.call",
          args: {
            handler: request.handler === "drop.action" ? "drop.mutation" : "drop.commit",
            args: {}
          }
        });
        return { outcome: "returned" as const, reply, guestMs: 0 };
      }
      const reply = yield* gateway.callback(request.callback.capability, request, {
        op: "tables.list",
        args: { table: "notes" }
      });
      assert.isTrue(reply.ok, JSON.stringify(reply));
      if (request.handler === "drop.probe")
        return { outcome: "returned" as const, reply, guestMs: 0 };
      if (request.handler === "drop.commit") {
        // A measurable held interval, not queue wait, belongs to both child and parent.
        yield* Effect.sleep(80);
        const written = yield* gateway.callback(request.callback.capability, request, {
          op: "tables.insert",
          args: { table: "notes", row: { title: "Nested mutation" } }
        });
        return { outcome: "returned" as const, reply: written, guestMs: 0 };
      }
      yield* Queue.offer(opened, request);
      return yield* Effect.never;
    });
  const invocations = yield* Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
    Effect.provideService(Executor.Executor, {
      bind: () =>
        Effect.succeed({
          binding: {
            companyId: bundle.companyId,
            patchId: bundle.patchId,
            versionId: bundle.versionId,
            sha256: bundle.sha256
          },
          processGeneration: 1
        }),
      invoke
    }),
    Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })
  );
  const call = Effect.fnUntraced(function* (
    handler: string,
    correlationId = newInternalId("call")
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* invocations.call(
      {
        handler,
        args: {},
        ...(handler === "drop.mutation"
          ? { mutationKey: `${now}-${randomBytes(16).toString("base64url")}` }
          : {})
      },
      { ...binding, correlationId },
      Effect.succeed(viewer)
    );
  });
  return { call, opened };
});

for (const kind of ["query", "mutation", "action"] as const) {
  it.layer(services, { excludeTestServices: true })(`dropped ${kind} callers`, (it) => {
    it.effect(
      "settles four dropped calls and leaves all four company slots usable",
      () =>
        Effect.gen(function* () {
          const placement = yield* prepare;
          const platform = yield* SqlClient.SqlClient;
          const { call, opened } = yield* host;
          for (let index = 0; index < 4; index++) {
            const correlationId = newInternalId("call");
            const caller = yield* call(`drop.${kind}`, correlationId).pipe(Effect.forkChild);
            yield* Queue.take(opened).pipe(Effect.timeout(2_000));
            yield* Fiber.interrupt(caller);
            if (index === 3) {
              // This cluster belongs to the test. Lose the real held session on the last drop.
              const sessions = yield* platform<{ pid: number }>`
              SELECT pid FROM pg_stat_activity WHERE datname = ${placement.databaseName}
                AND state LIKE 'idle in transaction%'`;
              assert.strictEqual(sessions.length, 1);
              yield* platform`SELECT pg_terminate_backend(${sessions[0]!.pid})`;
            }
            const settled = yield* Effect.gen(function* () {
              while (true) {
                const rows = yield* platform<{ outcome: string; reply_delivered: boolean }>`
                SELECT outcome, reply_delivered FROM runtime_invocations
                WHERE correlation_id = ${correlationId}
                  AND NOT EXISTS (
                    SELECT 1 FROM runtime_invocations
                    WHERE patch_id = ${binding.patchId} AND outcome = 'pending'
                  )`;
                if (rows[0] !== undefined && rows[0].outcome !== "pending") return rows[0];
                yield* Effect.sleep(20);
              }
            }).pipe(Effect.timeout(2_500));
            assert.isFalse(settled.reply_delivered);
            const pending = yield* platform`
            SELECT id FROM runtime_invocations WHERE patch_id = ${binding.patchId} AND outcome = 'pending'`;
            assert.deepStrictEqual(pending, []);
            const held = yield* platform`
            SELECT pid FROM pg_stat_activity WHERE datname = ${placement.databaseName}
              AND state LIKE 'idle in transaction%'`;
            assert.deepStrictEqual(held, []);
          }
          const probes = yield* Effect.all(
            Array.from({ length: 4 }, () => call("drop.probe")),
            { concurrency: 4 }
          );
          for (const reply of probes) {
            assert.isTrue(reply.ok);
            if (reply.ok) assert.deepInclude(reply.value, { rows: [] });
          }
        }),
      20_000
    );
  });
}

it.layer(services, { excludeTestServices: true })("nested mutation database time", (it) => {
  it.effect(
    "includes the real nested mutation's held connection time in its parent action",
    () =>
      Effect.gen(function* () {
        yield* prepare;
        const { call } = yield* host;
        const reply = yield* call("drop.nested");
        assert.isTrue(reply.ok);
        if (reply.ok) assert.deepInclude(reply.value, { title: "Nested mutation" });
        const platform = yield* SqlClient.SqlClient;
        const rows = yield* platform<{ child_ms: number; parent_ms: number; outcome: string }>`
        SELECT child.db_ms AS child_ms, parent.db_ms AS parent_ms, child.outcome
        FROM runtime_invocations child JOIN runtime_invocations parent ON child.parent_id = parent.id
        WHERE parent.handler = 'drop.nested' AND child.handler = 'drop.commit'`;
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0]!.outcome, "success");
        assert.isAtLeast(rows[0]!.child_ms, 70);
        assert.isAtLeast(rows[0]!.parent_ms, rows[0]!.child_ms);
      }),
    10_000
  );
});
