import { assert, it } from "@effect/vitest";
import {
  CURRENT_RELEASE,
  TableRow,
  WIRE_VERSION,
  type GuestProtocol,
  type ServerCallReply
} from "@patchy/api";
import * as CompanyDatabases from "../../company-database/src/CompanyDatabases.js";
import * as Inventory from "../../company-database/src/Inventory.js";
import * as Testing from "../../company-database/src/testing.js";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import { newInternalId } from "@patchy/core";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Tables from "../../primitives/src/Tables.js";
import * as TableOperations from "../../primitives/src/TableOperations.js";
import * as MutationAdapter from "../../primitives/src/MutationTransaction.js";
import * as QueryAdapter from "../../primitives/src/QuerySnapshot.js";
import * as ResourceRevisions from "../../primitives/src/ResourceRevisions.js";
import * as TestWakes from "../../primitives/src/test/wakes.js";
import * as Binding from "./Binding.js";
import * as CallbackGateway from "./CallbackGateway.js";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as MutationTransaction from "./MutationTransaction.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as ServerBundles from "./ServerBundles.js";
import * as Runtime from "./Runtime.js";

const viewer = {
  user: { id: "usr_dev", name: "Dev", email: "dev@patchy.local" },
  company: { id: "cmp_dev", name: "Dev", handle: "patchy-dev" },
  admin: true
};
const definition = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  tier: 2,
  files: {},
  uses: {},
  tables: {
    counter: {
      description: "Counter",
      columns: { value: { kind: "integer" as const } },
      indexes: {}
    }
  },
  handlers: {
    "demo.mutate": {
      kind: "mutation" as const,
      args: { id: { kind: "text" as const } },
      result: { kind: "json" as const }
    }
  }
};
const services = Layer.mergeAll(
  Tables.layer,
  InvocationLog.layer,
  RuntimeLog.layer,
  OperatingLimits.layer,
  Limits.layer
).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(
    Layer.succeed(LoadedVersions.LoadedVersions, { find: () => Effect.succeed(Option.none()) })
  )
);
const setup = Effect.fnUntraced(function* (patchId: string) {
  const platform = yield* SqlClient.SqlClient;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name)
    VALUES (${patchId}, 'cmp_dev', 'usr_dev', 'Mutation acceptance', ${patchId})`;
  yield* databases.ensureReady("cmp_dev");
  yield* databases.withCompany("cmp_dev")(
    databases.withPatchLock(patchId)(tables.provision(patchId, definition))
  );
  const binding = Binding.Binding.of({
    companyId: "cmp_dev",
    patchId,
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    manifest: definition,
    wireVersion: WIRE_VERSION,
    scope: "company",
    identity: viewer,
    principal: { userId: viewer.user.id },
    correlationId: "mutation-acceptance"
  });
  const handlers = yield* TableOperations.make;
  const row = yield* handlers["tables.insert"]
    .run({ table: "counter", row: { value: 0 } })
    .pipe(
      Effect.provideService(Binding.Binding, binding),
      Effect.flatMap(Schema.decodeUnknownEffect(TableRow))
    );
  const sql = <A, E, R>(work: Effect.Effect<A, E, R>) => databases.withCompany("cmp_dev")(work);
  const value = sql(
    Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
      sql.unsafe<{ value: number }>(
        `SELECT value FROM ${Inventory.quoteIdentifier(Inventory.namespace(patchId))}.counter`
      )
    )
  );
  return { binding, handlers, id: String(row.id), sql, value };
});
const host = Effect.fnUntraced(function* (
  fixture: {
    readonly binding: Binding.Binding["Service"];
    readonly id: string;
    readonly handlers: Readonly<Record<string, Runtime.Handler>>;
  },
  execute: (
    request: GuestProtocol.Invoke,
    gateway: CallbackGateway.CallbackGateway["Service"]
  ) => Effect.Effect<GuestProtocol.InvokeReply>,
  adaptSession: (session: MutationTransaction.Session) => MutationTransaction.Session = (session) =>
    session,
  adaptStorage: (
    storage: MutationTransaction.MutationTransaction["Service"]
  ) => MutationTransaction.MutationTransaction["Service"] = (storage) => storage
) {
  const capabilities = yield* InvocationCapabilities.make;
  const storage = yield* MutationAdapter.make;
  const gateway = yield* CallbackGateway.make(fixture.handlers).pipe(
    Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities)
  );
  const snapshots = yield* QueryAdapter.make.pipe(
    Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities)
  );
  const bundle: GuestProtocol.Bundle = {
    companyId: "cmp_dev",
    patchId: fixture.binding.patchId,
    versionId: fixture.binding.versionId,
    sha256: "0".repeat(64),
    bundle: "mutation-acceptance-executor"
  };
  const invocations = yield* Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
    Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
    Effect.provideService(
      MutationTransaction.MutationTransaction,
      adaptStorage({
        lookup: storage.lookup,
        open: (capability) => storage.open(capability).pipe(Effect.map(adaptSession))
      })
    ),
    Effect.provideService(QuerySnapshot.QuerySnapshot, snapshots),
    Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) }),
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
      invoke: (request) => execute(request, gateway)
    })
  );
  const call = (key?: string, id = fixture.id, binding = fixture.binding) =>
    Effect.gen(function* () {
      return yield* invocations.call(
        {
          handler: "demo.mutate",
          args: { id },
          mutationKey: key ?? (yield* MutationTransaction.mint)
        },
        { ...binding, correlationId: newInternalId("call") },
        Effect.succeed(binding.identity!)
      );
    });
  return { call, invocations, storage, capabilities };
});
const increment = Effect.fnUntraced(function* (
  request: GuestProtocol.Invoke,
  gateway: CallbackGateway.CallbackGateway["Service"]
) {
  const read = yield* gateway.callback(request.callback.capability, request, {
    op: "tables.get",
    args: { table: "counter", id: request.args.id }
  });
  if (!read.ok) return { outcome: "returned" as const, reply: read, guestMs: 1 };
  const row = Schema.decodeUnknownSync(TableRow)("value" in read ? read.value : null);
  const updated = yield* gateway.callback(request.callback.capability, request, {
    op: "tables.update",
    args: { table: "counter", id: request.args.id, patch: { value: Number(row.value) + 1 } }
  });
  return {
    outcome: "returned" as const,
    reply: updated.ok ? { ok: true as const, value: Number(row.value) + 1 } : updated,
    guestMs: 1
  };
});

it.layer(services)("Mutation SERIALIZABLE acceptance", (it) => {
  it.effect(
    "commits eight concurrent increments and never reports busy for fifty hot-row calls",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup("mutation40001");
        const runtime = yield* host(fixture, increment);
        const eight = yield* Effect.all(
          Array.from({ length: 8 }, () => runtime.call()),
          { concurrency: 8 }
        );
        assert.isTrue(eight.every((reply) => reply.ok));
        assert.strictEqual((yield* fixture.value)[0]!.value, 8);
        // Four active calls exercise the unchanged four-slot pool without overflowing its 32-waiter admission bound.
        const fifty = yield* Effect.all(
          Array.from({ length: 50 }, () => runtime.call().pipe(Effect.result)),
          { concurrency: 4 }
        );
        let committed = 0;
        for (const result of fifty) {
          if (result._tag === "Success") {
            assert.isTrue(result.success.ok);
            committed++;
          } else assert.strictEqual(result.failure.code, "write_conflict");
        }
        assert.strictEqual((yield* fixture.value)[0]!.value, 8 + committed);
      }).pipe(Effect.scoped, TestClock.withLive, Random.withSeed("mutation-contention"))
  );

  it.effect(
    "rolls back a write followed by a throw and persists a callback-free result for replay",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup("mutation40002");
        yield* fixture.handlers["tables.delete"]
          .run({ table: "counter", id: fixture.id })
          .pipe(Effect.provideService(Binding.Binding, fixture.binding));
        const failing = yield* host(fixture, (request, gateway) =>
          Effect.gen(function* () {
            const inserted = yield* gateway.callback(request.callback.capability, request, {
              op: "tables.insert",
              args: { table: "counter", row: { value: 1 } }
            });
            assert.isTrue(inserted.ok);
            return { outcome: "guest_failed" as const, guestMs: 1 };
          })
        );
        assert.strictEqual((yield* failing.call().pipe(Effect.flip)).code, "handler_failed");
        assert.deepStrictEqual(yield* fixture.value, []);
        let executions = 0;
        const quiet = yield* host(fixture, () =>
          Effect.sync(() => {
            executions++;
            return { outcome: "returned", guestMs: 1, reply: { ok: true, value: 42 } };
          })
        );
        const key = yield* MutationTransaction.mint;
        const reply = yield* quiet.call(key);
        assert.deepStrictEqual(reply, { ok: true, value: 42, revisions: {} });
        assert.deepStrictEqual(yield* quiet.call(key), reply);
        assert.strictEqual(executions, 1);
        assert.strictEqual(
          (yield* quiet.call(key, "different arguments").pipe(Effect.flip)).code,
          "invalid_request"
        );
        const anotherViewer = {
          ...fixture.binding,
          identity: { ...viewer, user: { ...viewer.user, id: "usr_other" } }
        };
        assert.strictEqual(
          (yield* quiet.call(key, fixture.id, anotherViewer).pipe(Effect.flip)).code,
          "invalid_request"
        );
        const now = yield* Clock.currentTimeMillis;
        for (const time of [now - 86_400_001, now + 300_001])
          assert.strictEqual(
            (yield* quiet.call(`${time}-${"a".repeat(22)}`).pipe(Effect.flip)).code,
            "invalid_request"
          );
        assert.strictEqual(executions, 1);
      }).pipe(Effect.scoped)
  );

  for (const [code, severity, Reason] of [
    ["57P01", "FATAL", SqlError.UnknownError],
    ["08006", "ERROR", SqlError.ConnectionError],
    ["40003", "ERROR", SqlError.UnknownError]
  ] as const)
    it.effect(`recovers committed success after an ambiguous PostgreSQL ${code} response`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup(`mutation40011${code.toLowerCase()}`);
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const serverFailure = Object.assign(new Error("Server response after durable COMMIT"), {
          code,
          severity,
          severityUnlocalized: severity
        });
        const commitFailure = new SqlError.SqlError({
          reason: new Reason({ cause: serverFailure })
        });
        let executions = 0;
        const runtime = yield* host(fixture, (request, gateway) => {
          executions++;
          return increment(request, gateway);
        }).pipe(
          Effect.provideService(CompanyDatabases.CompanyDatabases, {
            ...databases,
            lease: (companyId, reserveAuthority) =>
              databases.lease(companyId, reserveAuthority).pipe(
                Effect.map((held) => {
                  const reserve = held.sql.reserve.pipe(
                    Effect.map((connection) => ({
                      ...connection,
                      executeRaw: (statement: string, params: ReadonlyArray<unknown>) =>
                        statement === "COMMIT"
                          ? connection
                              .executeRaw(statement, params)
                              .pipe(Effect.andThen(Effect.fail(commitFailure)))
                          : connection.executeRaw(statement, params)
                    }))
                  );
                  Object.assign(held.sql, { reserve });
                  return held;
                })
              )
          })
        );
        const key = yield* MutationTransaction.mint;
        const reply = yield* runtime.call(key);
        assert.isTrue(reply.ok);
        if (reply.ok) assert.strictEqual(reply.value, 1);
        assert.deepStrictEqual(yield* runtime.call(key), reply);
        assert.strictEqual(executions, 1);
        assert.deepStrictEqual(yield* fixture.value, [{ value: 1 }]);
      }).pipe(Effect.scoped)
    );

  it.effect(
    "returns proven commit success when journal reconciliation hangs past the deadline",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup("mutation40010");
        const original = yield* host(fixture, increment);
        const key = yield* MutationTransaction.mint;
        const committedReply = yield* original.call(key);
        const log = yield* InvocationLog.InvocationLog;
        const reconciling = yield* Deferred.make<void>();
        const connectionLost = new Error("Company database connection closed after key lookup");
        let lookupAvailable = true;
        const retry = yield* host(
          fixture,
          () => Effect.die("A committed mutation must not execute again"),
          (session) => session,
          (storage) => ({
            ...storage,
            lookup: (binding, mutationKey) =>
              Effect.suspend(() =>
                lookupAvailable
                  ? storage.lookup(binding, mutationKey)
                  : Effect.fail(new Runtime.SourceUnavailable({ cause: connectionLost }))
              )
          })
        ).pipe(
          Effect.provideService(InvocationLog.InvocationLog, {
            ...log,
            reconcileMutation: () =>
              Effect.gen(function* () {
                lookupAvailable = false;
                yield* Deferred.succeed(reconciling, undefined);
                return yield* Effect.never;
              })
          })
        );
        const replay = yield* retry.call(key).pipe(Effect.forkChild);
        yield* Deferred.await(reconciling);
        yield* TestClock.adjust(yield* ContractLimits.get("tier2.mutation.deadline"));
        assert.deepStrictEqual(yield* Fiber.join(replay), committedReply);
        assert.deepStrictEqual(yield* fixture.value, [{ value: 1 }]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "reconciles the original unknown invocation after a committed reply loses its acknowledgement",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup("mutation40009");
        const log = yield* InvocationLog.InvocationLog;
        const committed = yield* Deferred.make<void>();
        const loseAcknowledgement = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<InvocationLog.Finish>();
        const connectionLost = new Error("Connection closed after the database committed");
        let unavailable = false;
        let executions = 0;
        let invocationId = "";
        let savedReply: ServerCallReply | undefined;
        const runtime = yield* host(
          fixture,
          (request, gateway) =>
            Effect.gen(function* () {
              executions++;
              invocationId = request.invocationId;
              const reply = yield* increment(request, gateway);
              return { ...reply, guestMs: 7 };
            }),
          (session) => ({
            ...session,
            get uncertain() {
              return unavailable || session.uncertain;
            },
            save: (key, reply) =>
              session.save(key, reply).pipe(
                Effect.tap((stored) =>
                  Effect.sync(() => {
                    savedReply = stored;
                  })
                )
              ),
            commit: session.commit.pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  unavailable = true;
                  yield* Deferred.succeed(committed, undefined);
                  yield* Deferred.await(loseAcknowledgement);
                  return yield* new MutationTransaction.CommitUnknown({ cause: connectionLost });
                })
              )
            )
          }),
          (storage) => ({
            ...storage,
            lookup: (binding, key) =>
              Effect.suspend(() =>
                unavailable
                  ? Effect.fail(new Runtime.SourceUnavailable({ cause: connectionLost }))
                  : storage.lookup(binding, key)
              )
          })
        ).pipe(
          Effect.provideService(InvocationLog.InvocationLog, {
            ...log,
            finish: (input) =>
              log.finish(input).pipe(Effect.tap(() => Deferred.succeed(finished, input)))
          })
        );
        const key = yield* MutationTransaction.mint;
        const first = yield* runtime.call(key).pipe(Effect.forkChild);
        yield* Deferred.await(committed);
        assert.deepStrictEqual(yield* fixture.value, [{ value: 1 }]);
        yield* TestClock.adjust(25);
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(loseAcknowledgement, undefined);
        const originalFinish = yield* Deferred.await(finished);
        const lookup = { companyId: fixture.binding.companyId, invocationId };
        const unknown = yield* log.find(lookup);
        assert.strictEqual(unknown?.outcome, "unknown_outcome");
        assert.strictEqual(unknown?.outcomeCode, "unknown_outcome");
        assert.strictEqual(unknown?.guestMs, 7);
        assert.strictEqual(unknown?.callbacks, 2);
        assert.strictEqual(unknown?.attempts, 1);
        assert.strictEqual(unknown?.resultBytes, 1);
        assert.strictEqual(unknown?.durationMs, 25);
        assert.isFalse(unknown?.replyDelivered);
        // Both acknowledgement and key lookup remain unavailable beyond the cleanup allowance.
        yield* TestClock.adjust((yield* ContractLimits.get("tier2.settlement.cleanup")) + 1);
        let journalUnavailable = true;
        const restarted = yield* host(fixture, (request, gateway) => {
          executions++;
          return increment(request, gateway);
        }).pipe(
          Effect.provideService(InvocationLog.InvocationLog, {
            ...log,
            reconcileMutation: (input) =>
              journalUnavailable
                ? Effect.fail(
                    new SqlError.SqlError({
                      reason: new SqlError.ConnectionError({ cause: connectionLost })
                    })
                  )
                : log.reconcileMutation(input)
          })
        );
        assert.strictEqual(
          (yield* restarted.call(key, "different arguments").pipe(Effect.flip)).code,
          "invalid_request"
        );
        assert.deepStrictEqual(yield* log.find(lookup), unknown);
        assert.deepStrictEqual(yield* restarted.call(key), savedReply);
        assert.deepStrictEqual(yield* log.find(lookup), unknown);
        journalUnavailable = false;
        assert.deepStrictEqual(yield* restarted.call(key), savedReply);
        const reconciled = yield* log.find(lookup);
        assert.deepStrictEqual(
          reconciled,
          new InvocationLog.Invocation({ ...unknown!, outcome: "success", outcomeCode: null })
        );
        yield* log.finish(originalFinish);
        assert.deepStrictEqual(yield* log.find(lookup), reconciled);
        assert.strictEqual(executions, 1);
        assert.deepStrictEqual(yield* fixture.value, [{ value: 1 }]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "refuses queued callbacks on return and commits only after the running callback finishes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup("mutation40008");
        const resourceKey = `table:${fixture.binding.patchId}:counter`;
        const before = yield* fixture.sql(ResourceRevisions.read([resourceKey]));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const returned = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<Fiber.Fiber<GuestProtocol.CallbackReply>>();
        const firstHandler = fixture.handlers["tables.update"];
        const runtime = yield* host(
          {
            ...fixture,
            handlers: {
              ...fixture.handlers,
              "tables.update": {
                ...firstHandler,
                run: (args: unknown) =>
                  firstHandler
                    .run(args)
                    .pipe(
                      Effect.tap(() =>
                        Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release))
                        )
                      )
                    )
              }
            }
          },
          (request, gateway) =>
            Effect.gen(function* () {
              yield* gateway
                .callback(request.callback.capability, request, {
                  op: "tables.update",
                  args: { table: "counter", id: fixture.id, patch: { value: 1 } }
                })
                .pipe(Effect.forkDetach);
              yield* Deferred.await(entered);
              const second = yield* gateway
                .callback(request.callback.capability, request, {
                  op: "tables.update",
                  args: { table: "counter", id: fixture.id, patch: { value: 99 } }
                })
                .pipe(Effect.forkDetach);
              yield* Deferred.succeed(queued, second);
              while (
                (yield* runtime.capabilities.resolve(request.callback.capability, request)).counters
                  .outstanding < 2
              )
                yield* Effect.yieldNow;
              yield* Deferred.succeed(returned, undefined);
              return { outcome: "returned", guestMs: 1, reply: { ok: true, value: "validated" } };
            })
        );
        const call = yield* runtime.call().pipe(Effect.forkChild);
        yield* Deferred.await(returned);
        const refused = yield* Deferred.await(queued).pipe(Effect.flatMap(Fiber.join));
        assert.isFalse(refused.ok);
        if (!refused.ok) assert.strictEqual(refused.code, "access_denied");
        assert.deepStrictEqual(yield* fixture.value, [{ value: 0 }]);
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(call), {
          ok: true,
          value: "validated",
          revisions: { [resourceKey]: String(BigInt(before[resourceKey]!) + 1n) }
        });
        assert.deepStrictEqual(yield* fixture.value, [{ value: 1 }]);
      }).pipe(Effect.scoped)
  );

  for (const deferred of [false, true])
    it.effect(
      `does not deduplicate an unrelated ${deferred ? "deferred" : "immediate"} unique violation`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* setup(deferred ? "mutation40006" : "mutation40005");
          yield* fixture.sql(
            Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
              sql.unsafe(`ALTER TABLE ${Inventory.quoteIdentifier(Inventory.namespace(fixture.binding.patchId))}.counter
        ADD CONSTRAINT unrelated_counter_value UNIQUE (value) ${deferred ? "DEFERRABLE INITIALLY DEFERRED" : ""}`)
            )
          );
          const runtime = yield* host(fixture, (request, gateway) =>
            Effect.gen(function* () {
              const reply = yield* gateway.callback(request.callback.capability, request, {
                op: "tables.insert",
                args: { table: "counter", row: { value: 0 } }
              });
              return {
                outcome: "returned",
                guestMs: 1,
                reply: reply.ok ? { ok: true, value: null } : reply
              };
            })
          );
          const key = yield* MutationTransaction.mint;
          assert.strictEqual(
            (yield* runtime.call(key).pipe(Effect.flip)).code,
            deferred ? "source_unavailable" : "unique_violation"
          );
          assert.deepStrictEqual(yield* fixture.value, [{ value: 0 }]);
          const keyBinding = yield* MutationTransaction.key(key, fixture.binding, "demo.mutate", {
            id: fixture.id
          });
          assert.isUndefined(yield* runtime.storage.lookup(fixture.binding, keyBinding));
        }).pipe(Effect.scoped)
    );

  it.effect("does not report a resolved COMMIT command with a ROLLBACK tag as success", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("mutation40007");
      const runtime = yield* host(fixture, increment, (session) =>
        Object.assign(Object.create(session) as MutationTransaction.Session, {
          commit: Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
            sql.unsafe("SELECT 1 / 0")
          ).pipe(
            Effect.provideContext(session.context),
            Effect.ignore,
            Effect.andThen(session.commit)
          )
        })
      );
      assert.strictEqual((yield* runtime.call().pipe(Effect.flip)).code, "source_unavailable");
      assert.deepStrictEqual(yield* fixture.value, [{ value: 0 }]);
    }).pipe(Effect.scoped)
  );

  for (const deferred of [false, true])
    it.effect(
      `resolves two independent hosts racing one key at ${deferred ? "COMMIT" : "INSERT"}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* setup(deferred ? "mutation40004" : "mutation40003");
          if (deferred)
            yield* fixture.sql(
              Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
                sql.unsafe(
                  "ALTER TABLE patchy.mutation_keys DROP CONSTRAINT mutation_keys_key, ADD CONSTRAINT mutation_keys_key UNIQUE (key) DEFERRABLE INITIALLY DEFERRED"
                )
              )
            );
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let arrivals = 0;
          let insertRaces = 0;
          let commitRaces = 0;
          const observe = (session: MutationTransaction.Session) =>
            Object.assign(Object.create(session) as MutationTransaction.Session, {
              save: (key: MutationTransaction.Key, reply: ServerCallReply) =>
                session.save(key, reply).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      if (MutationTransaction.isKeyRace(error)) insertRaces++;
                    })
                  )
                ),
              commit: session.commit.pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    if (MutationTransaction.isKeyRace(error)) commitRaces++;
                  })
                )
              )
            });
          const execute = () =>
            Effect.gen(function* () {
              if (++arrivals === 2) yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return {
                outcome: "returned" as const,
                guestMs: 1,
                reply: { ok: true as const, value: "one outcome" }
              };
            });
          const first = yield* host(fixture, execute, observe);
          const second = yield* host(fixture, execute, observe);
          const key = yield* MutationTransaction.mint;
          const calls = yield* Effect.all([first.call(key), second.call(key)], {
            concurrency: 2
          }).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          const replies = yield* Fiber.join(calls);
          assert.deepStrictEqual(replies[0], replies[1]);
          const rows = yield* fixture.sql(
            Effect.flatMap(
              CompanyDatabases.CompanyConnection,
              (sql) => sql`SELECT key FROM patchy.mutation_keys WHERE key = ${key}`
            )
          );
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(deferred ? commitRaces : insertRaces, 1);
          if (deferred)
            yield* fixture.sql(
              Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
                sql.unsafe(
                  "ALTER TABLE patchy.mutation_keys DROP CONSTRAINT mutation_keys_key, ADD CONSTRAINT mutation_keys_key PRIMARY KEY (key)"
                )
              )
            );
        }).pipe(Effect.scoped)
    );
});
