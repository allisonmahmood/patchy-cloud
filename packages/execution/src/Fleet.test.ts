// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- actual child supervisors use wall-clock deadlines; TestClock controls the host's idle and breaker windows.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as GuestProtocol from "@patchy/api/guest";
import type * as Management from "@patchy/api/management";
import { OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Fleet from "./fleet.js";
import * as FleetStore from "./fleetStore.js";
import * as LocalTaskProvider from "./localTaskProvider.js";
import * as LocalTaskStore from "./localTaskStore.js";
import * as TaskProvider from "./TaskProvider.js";
import * as MemoryTasks from "./test/memoryTasks.js";

const callbackUrl = "http://127.0.0.1:32127/callback";
const source = `let count = 0; export default { async fetch(request) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  if (input.handler === "demo.spin") { for (;;) {} }
  return Response.json({ ok: true, value: ++count });
} };`;
const sha256 = createHash("sha256").update(source).digest("hex");
const services = OperatingLimits.layer.pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.merge(WideEvents.layerNoop),
  Layer.merge(FetchHttpClient.layer)
);
const setup = Effect.fn("FleetTest.setup")(function* (
  name: string,
  provider: TaskProvider.TaskProvider["Service"],
  otherProvider: TaskProvider.TaskProvider["Service"],
  warm: boolean
) {
  yield* TestClock.setTime(Date.now());
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE execution_deployments, execution_housekeeping, execution_breakers CASCADE`;
  yield* sql`INSERT INTO execution_rollout(singleton) VALUES (true)`;
  const companyId = `cmp_fleet_${name}`;
  yield* sql`INSERT INTO companies(id, handle, name) VALUES (${companyId}, ${`fleet-${name}`}, 'Fleet test')`;
  const left = yield* Fleet.make({
    replicaId: `${name}-left`,
    deploymentRevision: name,
    automaticHousekeeping: false
  }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
  const right = yield* Fleet.make({
    replicaId: `${name}-right`,
    deploymentRevision: name,
    automaticHousekeeping: false
  }).pipe(Effect.provideService(TaskProvider.TaskProvider, otherProvider));
  const bundle: GuestProtocol.Bundle = {
    companyId,
    patchId: `pat_${name}`,
    versionId: `ver_${name}`,
    sha256,
    bundle: source
  };
  if (warm) {
    yield* left.housekeeping();
    yield* sql`DELETE FROM execution_housekeeping WHERE owner_id = ${`${name}-left`}`;
  }
  return { sql, companyId, provider, left, right, bundle };
});
/** Controller state over one in-memory inventory; no task runs a supervisor or patch code. */
const setupMemory = (name: string, warm = true) => {
  const provider = MemoryTasks.make();
  return setup(name, provider, provider, warm);
};
/** Real detached owners and supervisors, reached through two independent host clients. */
const setupLocal = Effect.fn("FleetTest.setupLocal")(function* (name: string) {
  const resource = yield* LocalTaskProvider.resource({ callbackUrls: [callbackUrl] });
  const fleet = yield* setup(
    name,
    yield* LocalTaskProvider.make(resource),
    yield* LocalTaskProvider.make(resource),
    true
  );
  return { ...fleet, resource };
});
// The pool would warm four spares, but the fleet budget allows two tasks.
const fleetBudget = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    PATCHY_LIMITS_JSON: '{"execution.fleet.budget":2,"execution.pool.spares":4}'
  })
);
const liveChildren = Effect.fn("FleetTest.liveChildren")(function* (directory: string) {
  return yield* Effect.promise(async () => {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = await LocalTaskStore.readRecord(join(directory, entry.name));
      if (record?.child && (await LocalTaskStore.alive(record.child))) total++;
    }
    return total;
  });
});

// A SQL commit alone is not a clock barrier: its fiber may not have armed its next
// sleep yet. Observe the real renewal query, then acknowledge its armed TestClock timer.
// The renewal loop runs that one query between 5s sleeps. The replenish loop also
// renews last before its own 5s sleep, but after other queries; counting it as
// armed let the clock outrun the renewal loop until the lease expired.
const renewalClock = Effect.gen(function* () {
  const clock = yield* TestClock.testClockWith(Effect.succeed);
  const armed = yield* Queue.unbounded<void>();
  const sinceSleep = new WeakMap<Fiber.Fiber<unknown, unknown>, Array<boolean>>();
  const transform: Statement.Transformer = (statement, _sql, fiber) =>
    Effect.sync(() => {
      const renewal = /^\s*UPDATE execution_housekeeping\b/.test(statement.compile()[0]);
      sinceSleep.set(fiber, [...(sinceSleep.get(fiber) ?? []), renewal]);
      return statement;
    });
  const observed: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.withFiber((fiber) => {
        const statements = sinceSleep.get(fiber) ?? [];
        sinceSleep.delete(fiber);
        const renewed = statements.length === 1 && statements[0] === true;
        if (Duration.toMillis(duration) !== 5_000 || !renewed) return clock.sleep(duration);
        return Effect.gen(function* () {
          const sleeping = yield* clock
            .sleep(duration)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Queue.offer(armed, undefined);
          yield* Fiber.join(sleeping);
        });
      })
  };
  return {
    provide: <A, E, R>(work: Effect.Effect<A, E, R>) =>
      work.pipe(
        Effect.provideService(Clock.Clock, observed),
        Effect.provideService(Statement.CurrentTransformer, transform)
      ),
    advance: Effect.fn("FleetTest.advanceRenewals")(function* (milliseconds: number) {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += 5_000) {
        yield* clock.adjust(5_000);
        yield* Queue.take(armed);
      }
    })
  };
});
// Waits on one phase of a case that drives a housekeeping pass. The case fails naming the
// phase when the pass ends first or the phase is still waiting after ten real seconds,
// instead of hanging until the test's own timeout.
const phase = <A, E>(
  name: string,
  wait: Effect.Effect<A, E>,
  pass?: Fiber.Fiber<unknown, unknown>
) =>
  Effect.raceAllFirst([
    wait,
    TestClock.withLive(Effect.sleep("10 seconds")).pipe(
      Effect.map(() => assert.fail(`${name}: still waiting after ten seconds`))
    ),
    ...(pass === undefined
      ? []
      : [
          Fiber.await(pass).pipe(
            Effect.map((exit) => assert.fail(`${name}: the housekeeping pass ended first: ${exit}`))
          )
        ])
  ]);
const request = (
  bundle: GuestProtocol.BundleBinding,
  generation: number,
  id: string,
  handler = "demo.read"
): GuestProtocol.Invoke => ({
  wire: 1,
  binding: bundle,
  processGeneration: generation,
  invocationId: id,
  attemptId: id,
  deadline: Date.now() + (handler === "demo.spin" ? 100 : 10_000),
  handler,
  args: {},
  viewer: {
    user: { id: "usr_fleet", name: "Reader", email: "reader@fleet.test" },
    company: { id: bundle.companyId, name: "Fleet", handle: "fleet" },
    admin: false
  },
  callback: { url: callbackUrl, capability: "host-owned-capability" }
});

const recording = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<WideEvents.WideEvent>();
  const records: WideEvents.WideEvent[] = [];
  const events = yield* WideEvents.make.pipe(
    Effect.provideService(WideEvents.Sink, {
      write: (event) =>
        Effect.sync(() => {
          records.push(event);
          Queue.offerUnsafe(queue, event);
        })
    })
  );
  return { events, records, take: Queue.take(queue) };
});

it.layer(services)("host fleet controller", (it) => {
  it.effect(
    "promotes a revision its hosts run once they warm its spares, never one none runs",
    () =>
      Effect.gen(function* () {
        const { sql, provider } = yield* setupMemory("promote-old");
        const candidate = yield* Fleet.make({
          replicaId: "promote-new-host",
          deploymentRevision: "promote-new",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        const refused = yield* Fleet.promote("promote-missing", "1 minute").pipe(Effect.flip);
        assert.strictEqual(refused._tag, "FleetRevisionNotRegistered");
        // Once staged, the new revision's hosts take over housekeeping and warm its spares.
        assert.isTrue(yield* candidate.stageDeployment("promote-new"));
        yield* candidate.housekeeping();
        yield* Fleet.promote("promote-new", "1 minute");
        const rollout = sql`SELECT current_revision, staged_revision FROM execution_rollout`;
        const promoted = { current_revision: "promote-new", staged_revision: null };
        assert.deepStrictEqual((yield* rollout)[0], promoted);
        // A rerun after success returns at once, even with its spares since claimed.
        yield* sql`DELETE FROM execution_tasks WHERE deployment_revision = 'promote-new'`;
        yield* Fleet.promote("promote-new", "1 minute");
        assert.deepStrictEqual((yield* rollout)[0], promoted);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "claims one company once and retries an ambiguous acknowledgement on its exact task and epoch",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, right } = yield* setupMemory("claim");
        const lost = yield* Deferred.make<void>();
        const attempts: Array<{ taskId: string; epoch: number }> = [];
        let first = true;
        const unreliable = TaskProvider.TaskProvider.of({
          ...provider,
          bind: Effect.fn("lostBindAcknowledgement")(function* (taskId, input) {
            attempts.push({ taskId, epoch: input.bindingEpoch });
            const reply = yield* provider.bind(taskId, input);
            if (first) {
              first = false;
              yield* Deferred.succeed(lost, undefined);
              return yield* new TaskProvider.TaskProviderError({
                operation: "bind",
                taskId,
                reason: "transport"
              });
            }
            return reply;
          })
        });
        const left = yield* Fleet.make({
          replicaId: "claim-loss",
          deploymentRevision: "claim",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, unreliable));
        yield* left.housekeeping();
        const bind = yield* left.ensureBinding(companyId).pipe(Effect.forkChild);
        yield* Deferred.await(lost);
        const other = yield* right.ensureBinding(companyId);
        yield* TestClock.adjust(50);
        const firstBinding = yield* Fiber.join(bind);
        assert.strictEqual(firstBinding.taskId, other.taskId);
        assert.strictEqual(firstBinding.bindingEpoch, other.bindingEpoch);
        assert.isAtLeast(attempts.length, 2);
        assert.isTrue(
          attempts.every(
            (attempt) => attempt.taskId === other.taskId && attempt.epoch === other.bindingEpoch
          )
        );
        const rows =
          yield* sql`SELECT task_id FROM execution_bindings WHERE company_id = ${companyId}
        AND state IN ('claiming', 'active')`;
        assert.strictEqual(rows.length, 1);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "reconciles a task stopped between the durable claim and its first supervisor bind",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, right, sql } = yield* setupMemory("prebind-stop");
        const claimed = yield* Deferred.make<void>();
        const pausedProvider = TaskProvider.TaskProvider.of({
          ...provider,
          bind: Effect.fn("pauseBeforeFirstBind")(function* () {
            yield* Deferred.succeed(claimed, undefined);
            return yield* Effect.never;
          })
        });
        const claimant = yield* Fleet.make({
          replicaId: "prebind-claimant",
          deploymentRevision: "prebind-stop",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, pausedProvider));
        const opening = yield* claimant.ensureBinding(companyId).pipe(Effect.forkChild);
        yield* Deferred.await(claimed);
        const claimedTask = (yield* sql<{
          task_id: string;
        }>`SELECT task_id FROM execution_bindings WHERE company_id = ${companyId}`)[0]!.task_id;
        assert.isTrue(yield* right.releaseCompany(companyId));
        yield* Fiber.interrupt(opening);
        const stopped = (yield* provider.list).find((task) => task.taskId === claimedTask)!;
        assert.strictEqual(stopped.state, "stopped");
        const finalStats = yield* provider.stats(claimedTask, { bindingEpoch: 0 });
        assert.include(finalStats, { companyId: null, bindingEpoch: 0, stopped: true });
        assert.deepStrictEqual(finalStats.reports, []);
        const history = (yield* right.history(companyId))[0]!;
        assert.strictEqual(history.releasedAt, stopped.stoppedAt);
        assert.strictEqual(history.releaseCause, "operator");
        assert.notStrictEqual((yield* right.ensureBinding(companyId)).taskId, claimedTask);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "abandons a housekeeping pass that lost its lease while provider observation was delayed",
    () =>
      Effect.gen(function* () {
        const { provider, right, sql } = yield* setupMemory("lease-loss");
        const observed = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const delayed = TaskProvider.TaskProvider.of({
          ...provider,
          list: Effect.gen(function* () {
            const snapshot = yield* provider.list;
            yield* Deferred.succeed(observed, undefined);
            yield* Deferred.await(resume);
            return snapshot;
          })
        });
        const old = yield* Fleet.make({
          replicaId: "expired-housekeeper",
          deploymentRevision: "lease-loss",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, delayed));
        const pass = yield* old.housekeeping().pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(observed);
        yield* sql`UPDATE execution_housekeeping SET expires_at = 0`;
        assert.isTrue(yield* right.housekeeping());
        yield* Deferred.succeed(resume, undefined);
        assert.strictEqual((yield* Fiber.join(pass))._tag, "Failure");
        assert.strictEqual(
          (yield* provider.list).filter((task) => task.state === "running").length,
          2
        );
        const spares =
          yield* sql`SELECT count(*)::integer AS total FROM execution_tasks WHERE state = 'spare'`;
        assert.strictEqual(spares[0]!.total, 2);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect("keeps the housekeeping lease when a renewal from an earlier clock lands late", () =>
    Effect.gen(function* () {
      const { sql } = yield* setupMemory("late-renewal", false);
      const store = yield* FleetStore.make;
      const t = yield* Clock.currentTimeMillis;
      const lease = (yield* store.lease("late-renewal-owner", "late-renewal", t, 15_000))!;
      const renew = (now: number) =>
        store.renewLease("late-renewal-owner", "late-renewal", lease.leaseEpoch, now, 15_000);
      assert.isTrue(yield* renew(t + 10_000));
      // A guard that read the clock at t reaches Postgres after the renewal at t + 10s.
      assert.isTrue(yield* renew(t));
      const rows = yield* sql<{
        expires_at: number;
      }>`SELECT expires_at FROM execution_housekeeping`;
      assert.strictEqual(rows[0]!.expires_at, t + 25_000);
      assert.isTrue(yield* renew(t + 20_000));
    }).pipe(Effect.scoped)
  );

  it.effect(
    "counts documents on another host and full invocation settlement before the thirty-minute idle window",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle } = yield* setupMemory("idle");
        const document = yield* Scope.make();
        yield* right.lifecycle.connect(companyId).pipe(Scope.provide(document));
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        yield* TestClock.adjust(30 * 60_000);
        yield* left.housekeeping();
        yield* Scope.close(document, Exit.void);
        yield* left.housekeeping();
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admission.binding.taskId)?.state,
          "running"
        );
        yield* admission.release;
        yield* left.housekeeping();
        yield* TestClock.adjust(30 * 60_000 - 1);
        yield* left.housekeeping();
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admission.binding.taskId)?.state,
          "running"
        );
        yield* TestClock.adjust(1);
        yield* left.housekeeping();
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admission.binding.taskId)?.state,
          "stopped"
        );
        assert.strictEqual((yield* left.history(companyId))[0]?.releaseCause, "idle");
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "allows only the leased replica to replenish, respects budget, and stops unknown provider tasks",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, bundle, left, right, sql } = yield* setupMemory("budget");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        assert.isTrue(yield* left.housekeeping());
        assert.isFalse(yield* right.housekeeping());
        assert.strictEqual(
          (yield* provider.list).filter((task) => task.state === "running").length,
          2
        );
        yield* provider.start({ taskId: "unrecorded-task", deploymentRevision: "budget" });
        yield* left.housekeeping();
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === "unrecorded-task")?.state,
          "stopped"
        );
        const rows = yield* sql`SELECT task_id FROM execution_tasks WHERE state <> 'stopped'`;
        assert.strictEqual(rows.length, 2);
        yield* TestClock.adjust(15_000);
        assert.isTrue(yield* right.housekeeping());
        assert.isFalse(yield* left.housekeeping());
        assert.strictEqual(
          (yield* right.ensureBinding(companyId)).taskId,
          admission.binding.taskId
        );
        yield* admission.release;
      }).pipe(Effect.scoped, Effect.provide(fleetBudget)),
    30_000
  );

  it.effect(
    "does not return a predecessor whose bind acknowledgement arrives after deployment replacement",
    () =>
      Effect.gen(function* () {
        const { provider, companyId } = yield* setupMemory("bind-rollout");
        const acknowledged = yield* Deferred.make<string>();
        const release = yield* Deferred.make<void>();
        let delayFirst = true;
        const delayed = TaskProvider.TaskProvider.of({
          ...provider,
          bind: Effect.fn("delayOldBindReply")(function* (taskId, input) {
            const reply = yield* provider.bind(taskId, input);
            if (delayFirst) {
              delayFirst = false;
              yield* Deferred.succeed(acknowledged, taskId);
              yield* Deferred.await(release);
            }
            return reply;
          })
        });
        const original = yield* Fleet.make({
          replicaId: "bind-rollout-owner",
          deploymentRevision: "bind-rollout",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, delayed));
        const opening = yield* original.ensureBinding(companyId).pipe(Effect.forkChild);
        const predecessor = yield* Deferred.await(acknowledged);
        const replacement = yield* Fleet.make({
          replicaId: "bind-rollout-new",
          deploymentRevision: "bind-rollout-new",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.isTrue(yield* replacement.stageDeployment("bind-rollout-new"));
        yield* replacement.housekeeping();
        assert.isTrue(yield* replacement.promoteDeployment("bind-rollout-new"));
        yield* replacement.housekeeping();
        yield* Deferred.succeed(release, undefined);
        const current = yield* Fiber.join(opening);
        assert.notStrictEqual(current.taskId, predecessor);
        const tasks = yield* provider.list;
        assert.strictEqual(tasks.find((task) => task.taskId === predecessor)?.state, "stopped");
        assert.strictEqual(
          tasks.find((task) => task.taskId === current.taskId)?.deploymentRevision,
          "bind-rollout-new"
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "renews the lease during concurrent cold starts longer than the lease and serves within the pool deadline",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, right, sql } = yield* setupMemory("slow-cold", false);
        const clock = yield* renewalClock;
        yield* clock.provide(
          Effect.gen(function* () {
            const starting = yield* Deferred.make<void>();
            const ids = new Set<string>();
            const slow = TaskProvider.TaskProvider.of({
              ...provider,
              start: Effect.fn("slowColdStart")(function* (input) {
                ids.add(input.taskId);
                if (ids.size === 2) yield* Deferred.succeed(starting, undefined);
                yield* Effect.sleep(25_000);
                return yield* provider.start(input);
              })
            });
            const owner = yield* Fleet.make({
              replicaId: "slow-cold-owner",
              deploymentRevision: "slow-cold",
              automaticHousekeeping: false
            }).pipe(Effect.provideService(TaskProvider.TaskProvider, slow));
            let settled = false;
            const opening = yield* owner.ensureBinding(companyId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  settled = true;
                })
              ),
              Effect.forkChild
            );
            yield* Deferred.await(starting);
            yield* clock.advance(20_000);
            assert.isFalse(settled);
            assert.isFalse(yield* right.housekeeping());
            const lease =
              (yield* sql`SELECT owner_id, lease_epoch FROM execution_housekeeping`)[0]!;
            assert.strictEqual(lease.owner_id, "slow-cold-owner");
            assert.strictEqual(lease.lease_epoch, 1);
            yield* TestClock.adjust(5_000);
            const binding = yield* Fiber.join(opening);
            // No lower bound: the wait is sampled before its claim, which can take a later spare.
            assert.isBelow(binding.spareWaitMs, 40_000);
            assert.strictEqual((yield* right.ensureBinding(companyId)).taskId, binding.taskId);
            const tasks = yield* provider.list;
            assert.strictEqual(tasks.filter((task) => task.state === "running").length, 2);
            assert.strictEqual(ids.size, 2);
          })
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PATCHY_LIMITS_JSON: '{"execution.fleet.budget":2}'
            })
          )
        )
      ),
    30_000
  );

  it.effect(
    "replenishes spares past a failed launch while a binding's stats call is blocked",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, left, sql } = yield* setupMemory("replenish");
        const [secondCompany, thirdCompany, fourthCompany] = [
          "cmp_fleet_replenish_second",
          "cmp_fleet_replenish_third",
          "cmp_fleet_replenish_fourth"
        ] as const;
        for (const company of [secondCompany, thirdCompany, fourthCompany])
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet replenish')`;
        // Both warm spares are bound, so the pass starts with an empty pool.
        const wedged = yield* left.ensureBinding(companyId);
        yield* left.ensureBinding(secondCompany);
        const observed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const launched: string[] = [];
        const blocked = TaskProvider.TaskProvider.of({
          ...provider,
          stats: (taskId, input) =>
            taskId === wedged.taskId
              ? Deferred.succeed(observed, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(provider.stats(taskId, input))
                )
              : provider.stats(taskId, input),
          // The failed launch's task stays starting and counts toward the spare target.
          start: Effect.fn("failFirstLaunch")(function* (input) {
            launched.push(input.taskId);
            if (launched.length === 1)
              return yield* new TaskProvider.TaskProviderError({
                operation: "start",
                taskId: input.taskId,
                reason: "provider"
              });
            return yield* provider.start(input);
          })
        });
        const owner = yield* Fleet.make({
          replicaId: "replenish-owner",
          deploymentRevision: "replenish",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, blocked));
        const pass = yield* owner.housekeeping().pipe(Effect.forkChild);
        yield* phase("stats call blocks", Deferred.await(observed), pass);
        // The pass's first replenishment launches two spares, and the second launch succeeds.
        const third = yield* phase("third company claims", owner.ensureBinding(thirdCompany), pass);
        assert.strictEqual(third.taskId, launched[1]);
        // The interval replenishment, armed when the pass began, launches a third spare.
        const fourth = yield* owner.ensureBinding(fourthCompany).pipe(Effect.forkChild);
        yield* TestClock.adjust(5_000);
        const claimed = yield* phase("fourth company claims", Fiber.join(fourth), pass);
        assert.strictEqual(claimed.taskId, launched[2]);
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(yield* phase("housekeeping pass", Fiber.join(pass)));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              // The lease's renewal loop stays asleep for the whole case.
              PATCHY_LIMITS_JSON: '{"execution.housekeeping.lease":600000}'
            })
          )
        )
      ),
    30_000
  );

  it.effect(
    "isolates a wedged stats call, a failed bind and a failed stop; the pass still completes",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, left, sql } = yield* setupMemory("isolated");
        const secondCompany = "cmp_fleet_isolated_second";
        const thirdCompany = "cmp_fleet_isolated_third";
        for (const company of [secondCompany, thirdCompany])
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet isolation')`;
        const wedged = yield* left.ensureBinding(companyId);
        const failing = yield* left.ensureBinding(secondCompany);
        yield* sql`UPDATE execution_bindings SET state = 'claiming' WHERE task_id = ${failing.taskId}`;
        yield* provider.start({ taskId: "isolated-stubborn", deploymentRevision: "isolated" });
        const observed = yield* Deferred.make<void>();
        const bindAttempted = yield* Deferred.make<void>();
        const stopAttempted = yield* Deferred.make<void>();
        const refused = (
          operation: "bind" | "stop",
          taskId: string,
          attempted: Deferred.Deferred<void>
        ) =>
          Deferred.succeed(attempted, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                new TaskProvider.TaskProviderError({ operation, taskId, reason: "transport" })
              )
            )
          );
        const unhealthy = TaskProvider.TaskProvider.of({
          ...provider,
          stats: (taskId, input) =>
            taskId === wedged.taskId
              ? Deferred.succeed(observed, undefined).pipe(Effect.andThen(Effect.never))
              : provider.stats(taskId, input),
          bind: (taskId, input) =>
            taskId === failing.taskId
              ? refused("bind", taskId, bindAttempted)
              : provider.bind(taskId, input),
          stop: (taskId) =>
            taskId === "isolated-stubborn"
              ? refused("stop", taskId, stopAttempted)
              : provider.stop(taskId)
        });
        const owner = yield* Fleet.make({
          replicaId: "isolated-owner",
          deploymentRevision: "isolated",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, unhealthy));
        const pass = yield* owner.housekeeping().pipe(Effect.forkChild);
        yield* phase("stats call wedges", Deferred.await(observed), pass);
        const healthy = yield* phase(
          "healthy company claims",
          owner.ensureBinding(thirdCompany),
          pass
        );
        assert.strictEqual(healthy.state, "active");
        yield* phase("bind attempt", Deferred.await(bindAttempted), pass);
        yield* phase("stop attempt", Deferred.await(stopAttempted), pass);
        // The wedged call's pool.wait timeout is the only timer due within 4 s; then the pass ends.
        yield* TestClock.adjust(4_000);
        assert.isTrue(yield* phase("housekeeping pass", Fiber.join(pass)));
        const rows =
          yield* sql`SELECT state FROM execution_bindings WHERE task_id = ${failing.taskId}`;
        assert.strictEqual(rows[0]!.state, "claiming");
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === "isolated-stubborn")!.state,
          "running"
        );
        const kept = yield* phase(
          "healthy company claims again",
          owner.ensureBinding(thirdCompany)
        );
        assert.strictEqual(kept.taskId, healthy.taskId);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              // The lease's renewal loop stays asleep; isolate gives up on provider calls at 4 s.
              PATCHY_LIMITS_JSON:
                '{"execution.housekeeping.lease":600000,"execution.pool.wait":4000}'
            })
          )
        )
      ),
    30_000
  );

  it.effect(
    "keeps a waiter until its full pool deadline despite failed provider work",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, left } = yield* setupMemory("wait-failures", false);
        yield* left.setLimitOverride({
          companyId,
          limitId: "execution.pool.wait",
          value: 4_000,
          actor: "fleet-test"
        });
        const attempted = yield* Deferred.make<void>();
        const unavailable = TaskProvider.TaskProvider.of({
          ...provider,
          start: Effect.fn("failStartAcknowledgement")(function* (input) {
            yield* provider.start(input);
            yield* Deferred.succeed(attempted, undefined);
            return yield* new TaskProvider.TaskProviderError({
              operation: "start",
              taskId: input.taskId,
              reason: "transport"
            });
          })
        });
        const host = yield* Fleet.make({
          replicaId: "wait-failures-owner",
          deploymentRevision: "wait-failures",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, unavailable));
        let settled = false;
        const opening = yield* host.ensureBinding(companyId).pipe(
          Effect.result,
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true;
            })
          ),
          Effect.forkChild
        );
        yield* Deferred.await(attempted);
        yield* TestClock.adjust(3_999);
        assert.isFalse(settled);
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(opening);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure.code, "busy");
          assert.strictEqual(result.failure.limitId, "execution.pool.wait");
          assert.strictEqual(result.failure.value, 4_000);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PATCHY_LIMITS_JSON: '{"execution.pool.wait":4000}'
            })
          )
        )
      ),
    30_000
  );

  it.effect(
    "leaves registration inert, promotes warm deployments incrementally, and rolls back an earlier revision",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, left, sql } = yield* setupMemory("staged-old");
        const companies = [companyId, "cmp_fleet_staged_second", "cmp_fleet_staged_third"];
        for (const company of companies.slice(1))
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Staged rollout')`;
        const original = [];
        for (const company of companies) {
          original.push(yield* left.ensureBinding(company));
          yield* left.housekeeping();
        }
        const candidate = yield* Fleet.make({
          replicaId: "staged-candidate",
          deploymentRevision: "staged-new",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        for (let restart = 0; restart < 3; restart++)
          yield* Fleet.make({
            replicaId: `staged-crash-loop-${restart}`,
            deploymentRevision: "unready-crash-loop",
            automaticHousekeeping: false
          }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        yield* left.housekeeping();
        assert.isFalse(yield* candidate.housekeeping());
        for (let index = 0; index < companies.length; index++)
          assert.strictEqual(
            (yield* candidate.ensureBinding(companies[index]!)).taskId,
            original[index]!.taskId
          );
        assert.isFalse(yield* candidate.promoteDeployment("staged-new"));
        assert.isTrue(yield* candidate.stageDeployment("staged-new"));
        assert.isFalse(yield* candidate.promoteDeployment("staged-new"));
        assert.isFalse(yield* left.housekeeping());
        assert.isTrue(yield* candidate.housekeeping());
        assert.isTrue(yield* candidate.promoteDeployment("staged-new"));
        // Promotion changes spare admission, not every company's existing binding at once.
        for (let index = 0; index < companies.length; index++)
          assert.strictEqual(
            (yield* candidate.ensureBinding(companies[index]!)).taskId,
            original[index]!.taskId
          );
        yield* candidate.housekeeping();
        const changed = yield* sql`SELECT b.company_id FROM execution_bindings b
        JOIN execution_tasks t ON t.task_id = b.task_id
        WHERE b.state = 'active' AND t.deployment_revision = 'staged-new'`;
        assert.strictEqual(changed.length, 1);
        for (let restart = 0; restart < 2; restart++)
          yield* Fleet.make({
            replicaId: `staged-old-restart-${restart}`,
            deploymentRevision: "staged-old",
            automaticHousekeeping: false
          }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.strictEqual(
          (yield* sql`SELECT current_revision FROM execution_rollout`)[0]!.current_revision,
          "staged-new"
        );
        for (let pass = 0; pass < companies.length; pass++) yield* candidate.housekeeping();
        yield* left.retireDeployment("staged-old");
        assert.isTrue(
          (yield* sql`SELECT retired FROM execution_deployments WHERE revision = 'staged-old'`)[0]!
            .retired
        );
        assert.isTrue(yield* left.stageDeployment("staged-old"));
        assert.isFalse(
          (yield* sql`SELECT retired FROM execution_deployments WHERE revision = 'staged-old'`)[0]!
            .retired
        );
        assert.isFalse(yield* candidate.housekeeping());
        yield* left.housekeeping();
        assert.isTrue(yield* left.promoteDeployment("staged-old"));
        for (let pass = 0; pass < companies.length; pass++) yield* left.housekeeping();
        for (const company of companies) {
          const binding = yield* candidate.ensureBinding(company);
          assert.strictEqual(
            (yield* provider.list).find((task) => task.taskId === binding.taskId)!
              .deploymentRevision,
            "staged-old"
          );
        }
        assert.strictEqual(
          (yield* sql`SELECT current_revision FROM execution_rollout`)[0]!.current_revision,
          "staged-old"
        );
        assert.isFalse(
          (yield* provider.list).some((task) => task.deploymentRevision === "unready-crash-loop")
        );
      }).pipe(Effect.scoped),
    60_000
  );
});

it.layer(services)("host fleet controller over local tasks", (it) => {
  it.effect(
    "fences before stop, refuses adoption of stopping, and routes old admitted work while an open binds fresh",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle } = yield* setupLocal("fence");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admission.binding);
        assert.isTrue(yield* left.releaseCompany(companyId));
        assert.isFalse(yield* right.adopt(admission.binding, "fence-left"));
        const fresh = yield* right.ensureBinding(companyId);
        assert.notStrictEqual(fresh.taskId, admission.binding.taskId);
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admission.binding.taskId)?.state,
          "running"
        );
        const reply = yield* left.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "draining-child"),
          admission.binding
        );
        assert.deepStrictEqual(reply.outcome === "returned" ? reply.reply : reply, {
          ok: true,
          value: 1
        });
        yield* admission.release;
        yield* left.housekeeping();
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admission.binding.taskId)?.state,
          "stopped"
        );
        const history = yield* left.history(companyId);
        assert.strictEqual(history[0]?.releaseCause, "operator");
        assert.isAtLeast(history[0]!.peakProcesses, 1);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "adopts only after global drain, advances the management epoch, and retains prior-epoch process metering",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle, sql } = yield* setupLocal("adopt");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admission.binding);
        assert.isFalse(yield* right.adopt(admission.binding, "adopt-left"));
        yield* admission.release;
        assert.isTrue(yield* right.adopt(admission.binding, "adopt-left"));
        const adopted = yield* right.lifecycle.acquire(companyId, bundle.patchId);
        assert.strictEqual(adopted.binding.taskId, admission.binding.taskId);
        assert.isAbove(adopted.binding.bindingEpoch, admission.binding.bindingEpoch);
        const stale = yield* provider
          .bind(admission.binding.taskId, {
            companyId,
            bindingEpoch: admission.binding.bindingEpoch
          })
          .pipe(Effect.flip);
        assert.strictEqual(stale.reason, "stale_epoch");
        const reply = yield* right.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "after-adoption"),
          adopted.binding
        );
        assert.strictEqual(reply.outcome, "returned");
        yield* adopted.release;
        yield* right.releaseCompany(companyId);
        const reports =
          yield* sql`SELECT binding_id, binding_epoch, calls_served FROM execution_processes
        WHERE task_id = ${admission.binding.taskId}`;
        const history = yield* right.history(companyId);
        assert.strictEqual(history.length, 1);
        assert.strictEqual(reports[0]!.binding_id, history[0]!.bindingId);
        assert.strictEqual(reports[0]!.binding_epoch, admission.binding.bindingEpoch);
        assert.strictEqual(reports[0]!.calls_served, 1);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "keeps live supervisors within the fleet budget and stops unknown provider tasks",
    () =>
      Effect.gen(function* () {
        const { provider, resource, left } = yield* setupLocal("physical-budget");
        yield* provider.start({ taskId: "unrecorded-task", deploymentRevision: "physical-budget" });
        assert.strictEqual(yield* liveChildren(resource.directory), 3);
        assert.isTrue(yield* left.housekeeping());
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === "unrecorded-task")?.state,
          "stopped"
        );
        assert.strictEqual(yield* liveChildren(resource.directory), 2);
      }).pipe(Effect.scoped, Effect.provide(fleetBudget)),
    30_000
  );

  it.effect(
    "promotes warm spares explicitly and replaces admissions while predecessor calls drain",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle } = yield* setupLocal("rollout-old");
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admitted.binding);
        const captured = yield* recording;
        const replacement = yield* Fleet.make({
          replicaId: "rollout-new",
          deploymentRevision: "rollout-new",
          automaticHousekeeping: false
        }).pipe(
          Effect.provideService(TaskProvider.TaskProvider, provider),
          Effect.provideService(WideEvents.WideEvents, captured.events)
        );
        assert.isFalse(yield* replacement.adopt(admitted.binding, "rollout-old-left"));
        assert.isTrue(yield* replacement.stageDeployment("rollout-new"));
        assert.isFalse(yield* replacement.promoteDeployment("rollout-new"));
        yield* replacement.housekeeping();
        assert.isTrue(yield* replacement.promoteDeployment("rollout-new"));
        assert.strictEqual((yield* left.ensureBinding(companyId)).taskId, admitted.binding.taskId);
        yield* replacement.housekeeping();
        const freshAdmission = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const fresh = freshAdmission.binding;
        assert.notStrictEqual(fresh.taskId, admitted.binding.taskId);
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === fresh.taskId)?.deploymentRevision,
          "rollout-new"
        );
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admitted.binding.taskId)?.state,
          "running"
        );
        const drainedReply = yield* left.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "rollout-admitted"),
          admitted.binding
        );
        assert.strictEqual(drainedReply.outcome, "returned");
        yield* admitted.release;
        yield* freshAdmission.release;
        yield* TestClock.adjust(15_000);
        yield* replacement.housekeeping();
        let event = yield* captured.take;
        while (event.type !== "binding" || event.taskId !== admitted.binding.taskId)
          event = yield* captured.take;
        assert.strictEqual(event.replica, "rollout-new");
        assert.strictEqual(event.deploymentRevision, "rollout-new");
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admitted.binding.taskId)?.state,
          "stopped"
        );
        assert.strictEqual((yield* left.history(companyId))[0]?.releaseCause, "deployment");
        yield* replacement.retireDeployment("rollout-new");
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === fresh.taskId)?.state,
          "stopped"
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "retains a quiesced task until final reports are persisted and acknowledged",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle, sql } = yield* setupLocal("quiesce");
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admitted.binding);
        yield* left.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "quiesce-call"),
          admitted.binding
        );
        yield* admitted.release;
        let loseAcknowledgement = true;
        const unreliable = TaskProvider.TaskProvider.of({
          ...provider,
          stats: (taskId, input) =>
            Effect.suspend(() => {
              if (loseAcknowledgement && input.acknowledgeReports?.length) {
                loseAcknowledgement = false;
                return Effect.fail(
                  new TaskProvider.TaskProviderError({
                    operation: "stats",
                    taskId,
                    reason: "transport"
                  })
                );
              }
              return provider.stats(taskId, input);
            })
        });
        const collector = yield* Fleet.make({
          replicaId: "quiesce-collector",
          deploymentRevision: "quiesce",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, unreliable));
        assert.isTrue(Exit.isFailure(yield* collector.releaseCompany(companyId).pipe(Effect.exit)));
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admitted.binding.taskId)?.state,
          "running"
        );
        const final = yield* provider.stats(admitted.binding.taskId, {
          bindingEpoch: admitted.binding.bindingEpoch
        });
        assert.isTrue(final.stopped);
        assert.strictEqual(final.processes.length, 0);
        assert.strictEqual(final.reports[0]!.callsServed, 1);
        const reports =
          yield* sql`SELECT calls_served FROM execution_processes WHERE task_id = ${admitted.binding.taskId}`;
        assert.deepStrictEqual(reports, [{ calls_served: 1 }]);
        yield* collector.housekeeping();
        const stopped = (yield* provider.list).find(
          (task) => task.taskId === admitted.binding.taskId
        )!;
        assert.strictEqual(stopped.state, "stopped");
        assert.strictEqual((yield* left.history(companyId))[0]!.releasedAt, stopped.stoppedAt);
        assert.deepStrictEqual(
          (yield* provider.stats(admitted.binding.taskId, {
            bindingEpoch: admitted.binding.bindingEpoch
          })).reports,
          []
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "persists and acknowledges final reports before stopping after a lost quiesce response",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle, sql } = yield* setupLocal("lost-quiesce");
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admitted.binding);
        yield* left.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "lost-quiesce-call"),
          admitted.binding
        );
        yield* admitted.release;
        const unreliable = TaskProvider.TaskProvider.of({
          ...provider,
          quiesce: Effect.fn("lostQuiesceResponse")(function* (taskId, bindingEpoch) {
            yield* provider.quiesce(taskId, bindingEpoch);
            return yield* new TaskProvider.TaskProviderError({
              operation: "quiesce",
              taskId,
              reason: "transport"
            });
          }),
          stop: Effect.fn("stopAfterFinalReports")(function* (taskId) {
            const final = yield* provider.stats(taskId, {
              bindingEpoch: admitted.binding.bindingEpoch
            });
            assert.isTrue(final.stopped);
            assert.deepStrictEqual(final.reports, []);
            assert.deepStrictEqual(
              yield* sql`SELECT binding_epoch, calls_served FROM execution_processes WHERE task_id = ${taskId}`.pipe(
                Effect.orDie
              ),
              [{ binding_epoch: admitted.binding.bindingEpoch, calls_served: 1 }]
            );
            return yield* provider.stop(taskId);
          })
        });
        const controller = yield* Fleet.make({
          replicaId: "lost-quiesce-controller",
          deploymentRevision: "lost-quiesce",
          automaticHousekeeping: false
        }).pipe(Effect.provide(Layer.succeed(TaskProvider.TaskProvider, unreliable)));
        assert.isTrue(yield* controller.releaseCompany(companyId));
        const stopped = (yield* provider.list).find(
          (task) => task.taskId === admitted.binding.taskId
        )!;
        assert.strictEqual(stopped.state, "stopped");
        const history = (yield* left.history(companyId))[0]!;
        assert.strictEqual(history.releaseCause, "operator");
        assert.strictEqual(history.releasedAt, stopped.stoppedAt);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "retains a fenced task when quiesce fails but its supervisor is still running",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle, sql } = yield* setupLocal("retry-quiesce");
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admitted.binding);
        yield* left.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "retry-quiesce-call"),
          admitted.binding
        );
        yield* admitted.release;
        let failQuiesce = true;
        const unreliable = TaskProvider.TaskProvider.of({
          ...provider,
          quiesce: (taskId, bindingEpoch) =>
            Effect.suspend(() =>
              failQuiesce
                ? Effect.fail(
                    new TaskProvider.TaskProviderError({
                      operation: "quiesce",
                      taskId,
                      reason: "transport"
                    })
                  )
                : provider.quiesce(taskId, bindingEpoch)
            )
        });
        const controller = yield* Fleet.make({
          replicaId: "retry-quiesce-controller",
          deploymentRevision: "retry-quiesce",
          automaticHousekeeping: false
        }).pipe(Effect.provide(Layer.succeed(TaskProvider.TaskProvider, unreliable)));
        assert.isTrue(
          Exit.isFailure(yield* controller.releaseCompany(companyId).pipe(Effect.exit))
        );
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admitted.binding.taskId)?.state,
          "running"
        );
        assert.isFalse(
          (yield* provider.stats(admitted.binding.taskId, {
            bindingEpoch: admitted.binding.bindingEpoch
          })).stopped
        );
        assert.deepStrictEqual(
          yield* sql`SELECT state, release_cause FROM execution_bindings
            WHERE task_id = ${admitted.binding.taskId}`,
          [{ state: "stopping", release_cause: "operator" }]
        );
        assert.isNull((yield* left.history(companyId))[0]!.releasedAt);
        failQuiesce = false;
        yield* controller.housekeeping();
        assert.strictEqual(
          (yield* provider.list).find((task) => task.taskId === admitted.binding.taskId)?.state,
          "stopped"
        );
        assert.strictEqual((yield* left.history(companyId))[0]!.releaseCause, "operator");
        assert.deepStrictEqual(
          yield* sql`SELECT calls_served FROM execution_processes WHERE task_id = ${admitted.binding.taskId}`,
          [{ calls_served: 1 }]
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "hard-stops an unavailable supervisor without claiming final process metering",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle, sql } = yield* setupLocal("unreachable");
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admitted.binding);
        yield* left.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "unreachable-call"),
          admitted.binding
        );
        yield* admitted.release;
        const unreachable = TaskProvider.TaskProvider.of({
          ...provider,
          quiesce: (taskId) =>
            Effect.fail(
              new TaskProvider.TaskProviderError({
                operation: "quiesce",
                taskId,
                reason: "transport"
              })
            ),
          stats: (taskId) =>
            Effect.fail(
              new TaskProvider.TaskProviderError({
                operation: "stats",
                taskId,
                reason: "transport"
              })
            )
        });
        const controller = yield* Fleet.make({
          replicaId: "unreachable-controller",
          deploymentRevision: "unreachable",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, unreachable));
        assert.isTrue(yield* controller.releaseCompany(companyId));
        const stopped = (yield* provider.list).find(
          (task) => task.taskId === admitted.binding.taskId
        )!;
        assert.strictEqual(stopped.state, "stopped");
        const history = (yield* left.history(companyId))[0]!;
        assert.strictEqual(history.releaseCause, "task_lost");
        assert.strictEqual(history.releasedAt, stopped.stoppedAt);
        assert.deepStrictEqual(
          yield* sql`SELECT report_id FROM execution_processes WHERE task_id = ${admitted.binding.taskId}`,
          []
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "reconciles stop time and emits the original process event once when report acknowledgement is retried",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle, sql } = yield* setupLocal("meter");
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admitted.binding);
        yield* left.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "meter-call"),
          admitted.binding
        );
        yield* admitted.release;
        const stopped = yield* provider.stop(admitted.binding.taskId);
        const original = (yield* provider.stats(admitted.binding.taskId, {
          bindingEpoch: admitted.binding.bindingEpoch
        })).reports[0]!.event;
        const captured = yield* recording;
        let loseAcknowledgement = true;
        const unreliable = TaskProvider.TaskProvider.of({
          ...provider,
          stats: (taskId, input) =>
            Effect.suspend(() => {
              if (loseAcknowledgement && input.acknowledgeReports?.length) {
                loseAcknowledgement = false;
                return Effect.fail(
                  new TaskProvider.TaskProviderError({
                    operation: "stats",
                    taskId,
                    reason: "transport"
                  })
                );
              }
              return provider.stats(taskId, input);
            })
        });
        const collector = yield* Fleet.make({
          replicaId: "meter-collector",
          deploymentRevision: "meter",
          automaticHousekeeping: false
        }).pipe(
          Effect.provideService(TaskProvider.TaskProvider, unreliable),
          Effect.provideService(WideEvents.WideEvents, captured.events)
        );
        yield* TestClock.adjust(15_000);
        assert.isTrue(yield* collector.housekeeping());
        yield* collector.housekeeping();
        let delivered = yield* captured.take;
        while (delivered.type !== "process" || delivered.taskId !== admitted.binding.taskId)
          delivered = yield* captured.take;
        assert.deepStrictEqual(delivered, original);
        assert.strictEqual(
          captured.records.filter(
            (event) => event.type === "process" && event.eventId === original.eventId
          ).length,
          1
        );
        const row = (yield* left.history(companyId))[0]!;
        assert.strictEqual(row.releasedAt, stopped.stoppedAt);
        assert.strictEqual(row.boundSeconds, Math.max(0, stopped.stoppedAt! - row.boundAt) / 1000);
        assert.strictEqual(row.releaseCause, "task_lost");
        const reports = yield* sql<{
          calls_served: number;
          cpu_seconds: number;
          peak_rss_bytes: number;
        }>`SELECT calls_served, cpu_seconds, peak_rss_bytes FROM execution_processes
        WHERE task_id = ${admitted.binding.taskId}`;
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(reports[0]!.calls_served, 1);
        assert.isAtLeast(reports[0]!.cpu_seconds, 0);
        assert.isAbove(reports[0]!.peak_rss_bytes, 0);
        assert.deepStrictEqual(
          (yield* provider.stats(admitted.binding.taskId, {
            bindingEpoch: admitted.binding.bindingEpoch
          })).reports,
          []
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "pauses across versions and hosts after three watchdog kills, clears on publish, and expires after ten minutes",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle, sql } = yield* setupLocal("breaker");
        const seed = (yield* sql`SELECT u.id AS user_id, m.id AS token_id FROM users u
        JOIN machine_tokens m ON m.user_id = u.id LIMIT 1`)[0]!;
        yield* sql`INSERT INTO patches(id, company_id, owner_user_id, title, name)
        VALUES (${bundle.patchId}, ${companyId}, ${seed.user_id}, 'Breaker', 'fleet-breaker')`;
        const publish = Effect.fn("publishVersion")(function* (number: number) {
          yield* sql`INSERT INTO patch_versions(id, patch_id, version_number, object_key, content_hash, file_size,
          created_by_machine_token_id, owner_user_id, tier, release, manifest_version, wire_version, schema_revision,
          manifest, publish_key, payload_digest, publish_response, publish_status, created_at)
          VALUES (${`breaker-published-${number}`}, ${bundle.patchId}, ${number}, ${`breaker/${number}`}, 'test', 1,
            ${seed.token_id}, ${seed.user_id}, 2, 'test', 1, 1, 0, '{}'::jsonb,
            ${`breaker-publish-${number}`}, 'test', '{}'::jsonb, 201, ${new Date()})`;
        });
        yield* publish(1);
        // One real watchdog kill proves the report plumbing. The other kills are synthetic
        // deadline reports that the real controller collects, persists and acknowledges.
        // This case binds no other version, so their process generations cannot collide.
        const synthetic = new Map<
          string,
          { readonly taskId: string; readonly report: Management.ProcessReport }
        >();
        const reporting = TaskProvider.TaskProvider.of({
          ...provider,
          stats: (taskId, input) =>
            provider.stats(taskId, input).pipe(
              Effect.map((stats) => {
                for (const reportId of input.acknowledgeReports ?? []) synthetic.delete(reportId);
                const pending = [...synthetic.values()].filter((kill) => kill.taskId === taskId);
                return {
                  ...stats,
                  reports: [...stats.reports, ...pending.map((kill) => kill.report)]
                };
              })
            )
        });
        const collector = yield* Fleet.make({
          replicaId: "breaker-collector",
          deploymentRevision: "breaker",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, reporting));
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(
          { ...bundle, versionId: "breaker-1-0" },
          admission.binding
        );
        const failure = yield* left.executor
          .invoke(
            request(loaded.binding, loaded.processGeneration!, "kill-1-0", "demo.spin"),
            admission.binding
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure.reason, "process_killed");
        // Invocation failure is fail-fast; final metering follows the actual child reap.
        const real = yield* TestClock.testClockWith((clock) =>
          clock.withLive(
            Effect.gen(function* () {
              while (true) {
                const stats = yield* provider.stats(admission.binding.taskId, {
                  bindingEpoch: admission.binding.bindingEpoch
                });
                const report = stats.reports.find(
                  (report) => report.processGeneration === loaded.processGeneration
                );
                if (report) return report;
                yield* Effect.sleep(10);
              }
            }).pipe(Effect.timeout("5 seconds"))
          )
        );
        assert.oneOf(real.cause, ["deadline", "stall", "memory"]);
        yield* admission.release;
        assert.isTrue(yield* collector.housekeeping());
        let generation = real.processGeneration;
        const kill = Effect.fn("syntheticKill")(function* (host: typeof left, versionId: string) {
          const admitted = yield* host.lifecycle.acquire(companyId, bundle.patchId);
          const reportId = `${real.reportId}:${versionId}`;
          generation++;
          synthetic.set(reportId, {
            taskId: admitted.binding.taskId,
            report: {
              ...real,
              reportId,
              binding: { ...real.binding, versionId },
              bindingEpoch: admitted.binding.bindingEpoch,
              processGeneration: generation,
              // Later than the latest publish, which resets the breaker at its creation time.
              endedAt: Date.now() + 1,
              cause: "deadline",
              invocations: [],
              event: {
                ...real.event,
                eventId: reportId,
                traceId: reportId,
                versionId,
                processGeneration: generation,
                cause: "deadline"
              }
            }
          });
          yield* admitted.release;
          assert.isTrue(yield* collector.housekeeping());
          assert.isFalse(synthetic.has(reportId));
        });
        yield* kill(right, "breaker-1-1");
        yield* kill(left, "breaker-1-2");
        for (const host of [left, right]) {
          const refusal = yield* host.lifecycle
            .acquire(companyId, bundle.patchId)
            .pipe(Effect.flip);
          assert.strictEqual(refusal.code, "patch_paused");
          assert.isAbove(refusal.retryAfterSeconds, 0);
          assert.strictEqual(refusal.scope, "patch");
          assert.strictEqual(refusal.limitId, "execution.breaker.kills");
          assert.strictEqual(refusal.value, 3);
        }
        const override = { companyId, limitId: "execution.breaker.kills", actor: "fleet-test" };
        yield* left.setLimitOverride({ ...override, value: 4 });
        assert.strictEqual(
          (yield* right.lifecycle.acquire(companyId, bundle.patchId).pipe(Effect.flip)).value,
          4
        );
        yield* left.removeLimitOverride(override);
        yield* publish(2);
        const fresh = yield* right.lifecycle.acquire(companyId, bundle.patchId);
        yield* fresh.release;
        for (let index = 0; index < 3; index++)
          yield* kill(index % 2 === 0 ? left : right, `breaker-2-${index}`);
        const paused = (yield* sql<{
          paused_until: number;
        }>`SELECT paused_until FROM execution_breakers WHERE company_id = ${companyId} AND patch_id = ${bundle.patchId}`)[0]!
          .paused_until;
        yield* TestClock.setTime(paused - 1);
        assert.strictEqual(
          (yield* left.lifecycle.acquire(companyId, bundle.patchId).pipe(Effect.flip)).code,
          "patch_paused"
        );
        yield* TestClock.adjust(1);
        const expired = yield* right.lifecycle.acquire(companyId, bundle.patchId);
        yield* expired.release;
        const metering =
          yield* sql`SELECT count(*)::integer AS kills FROM execution_breaker_kills WHERE company_id = ${companyId}`;
        assert.strictEqual(metering[0]!.kills, 6);
      }).pipe(Effect.scoped),
    30_000
  );
});
