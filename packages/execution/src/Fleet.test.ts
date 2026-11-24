// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- actual child supervisors use wall-clock deadlines; TestClock controls the host's idle and breaker windows.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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
import * as ActiveMembersTest from "./test/activeMembers.js";
import * as MemoryTasks from "./test/memoryTasks.js";
import { NodeCryptography } from "@patchy/core";

const callbackUrl = "http://127.0.0.1:32127/callback";
const source = `let count = 0; export default { async fetch(request) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  if (input.handler === "demo.spin") { for (;;) {} }
  return Response.json({ ok: true, value: ++count });
} };`;
const sha256 = createHash("sha256").update(source).digest("hex");
const services = Layer.merge(OperatingLimits.layer, ActiveMembersTest.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.merge(WideEvents.layerNoop),
  Layer.merge(FetchHttpClient.layer),
  Layer.provideMerge(Layer.merge(NodeCrypto.layer, NodeCryptography.layer))
);
const setup = Effect.fn("FleetTest.setup")(function* (
  name: string,
  provider: TaskProvider.TaskProvider["Service"],
  otherProvider: TaskProvider.TaskProvider["Service"],
  warm: boolean
) {
  yield* TestClock.setTime(Date.now());
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE execution_deployments, execution_housekeeping, execution_breakers, execution_pool_waits CASCADE`;
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
// A hold that must last across a jump of the clock: with the activity session's liveness check
// a day apart, no check times out against a real query while TestClock runs past it.
const quietActivity = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    PATCHY_LIMITS_JSON: '{"execution.housekeeping.interval":86400000}'
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
// Records each statement `work` sends through the platform client and whether a transaction
// held it. The activity session's lock and unlock bypass the client and are not recorded.
const recordStatements = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<{ readonly text: string; readonly inTransaction: boolean }> = [];
    const transform: Statement.Transformer = (statement, _sql, fiber) =>
      Effect.sync(() => {
        statements.push({
          text: statement.compile()[0].replace(/\s+/g, " ").trim(),
          inTransaction: Context.getOption(fiber.context, sql.transactionService)._tag === "Some"
        });
        return statement;
      });
    const result = yield* work.pipe(Effect.provideService(Statement.CurrentTransformer, transform));
    return { result, statements };
  });
// Waits until a statement in this case's database is blocked on a lock, the barrier for cases
// that race a call against a transaction held open.
const lockWait = Effect.fn("FleetTest.lockWait")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* phase(
    name,
    Effect.gen(function* () {
      while (true) {
        const rows = yield* sql<{ waiting: number }>`SELECT count(*)::integer AS waiting
          FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (rows[0]!.waiting > 0) return;
        yield* TestClock.withLive(Effect.sleep(5));
      }
    })
  );
});
// A held call that began `ms` ago: its crash protection and the clock it started are aged in
// place. Moving the clock while a call holds its binding can time out the activity session's
// probe, and the session's reconnect frees its locks for a moment.
const ranFor = Effect.fn("FleetTest.ranFor")(function* (taskId: string, ms: number) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE execution_bindings
    SET protected_until = LEAST(protected_until, ${now - ms + 65_000}),
      agent_activity_at = LEAST(agent_activity_at, ${now - ms})
    WHERE task_id = ${taskId}`;
});
// Records a patch and returns how to publish its versions, whose numbers a breaker reads.
const publishedPatch = Effect.fn("FleetTest.publishedPatch")(function* (
  companyId: string,
  patchId: string,
  name: string
) {
  const sql = yield* SqlClient.SqlClient;
  const seed = (yield* sql`SELECT u.id AS user_id, m.id AS token_id FROM users u
    JOIN machine_tokens m ON m.user_id = u.id LIMIT 1`)[0]!;
  yield* sql`INSERT INTO patches(id, company_id, owner_user_id, title, name)
    VALUES (${patchId}, ${companyId}, ${seed.user_id}, 'Breaker', ${name})`;
  return Effect.fn("FleetTest.publishVersion")(function* (number: number) {
    yield* sql`INSERT INTO patch_versions(id, patch_id, version_number, object_key, content_hash, file_size,
      created_by_machine_token_id, owner_user_id, tier, release, manifest_version, wire_version, schema_revision,
      manifest, publish_key, payload_digest, publish_response, publish_status, created_at)
      VALUES (${`${patchId}-published-${number}`}, ${patchId}, ${number}, ${`${patchId}/${number}`}, 'test', 1,
        ${seed.token_id}, ${seed.user_id}, 2, 'test', 1, 1, 0, '{}'::jsonb,
        ${`${patchId}-publish-${number}`}, 'test', '{}'::jsonb, 201, ${new Date()})`;
  });
});
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
    "counts an active document or an admitted invocation on another host before the thirty-minute idle window",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle } = yield* setupMemory("idle");
        const document = yield* Scope.make();
        yield* right.lifecycle.connect(companyId).pipe(Scope.provide(document));
        const bound = yield* right.ensureBinding(companyId);
        const state = Effect.map(
          provider.list,
          (tasks) => tasks.find((task) => task.taskId === bound.taskId)?.state
        );
        yield* TestClock.adjust(30 * 60_000);
        yield* left.housekeeping();
        assert.strictEqual(yield* state, "running");
        const admission = yield* right.lifecycle.acquire(companyId, bundle.patchId, "page");
        assert.strictEqual(admission.binding.taskId, bound.taskId);
        yield* Scope.close(document, Exit.void);
        yield* left.housekeeping();
        assert.strictEqual(yield* state, "running");
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
    "keeps a company an agent's call bound for a minute after it settles, however long it ran",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, right, bundle } = yield* setupMemory("agent-idle");
        const captured = yield* recording;
        const keeper = yield* Fleet.make({
          replicaId: "agent-idle-keeper",
          deploymentRevision: "agent-idle",
          automaticHousekeeping: false
        }).pipe(
          Effect.provideService(TaskProvider.TaskProvider, provider),
          Effect.provideService(WideEvents.WideEvents, captured.events)
        );
        const admission = yield* right.lifecycle.acquire(companyId, bundle.patchId, "agent");
        const state = Effect.map(
          provider.list,
          (tasks) => tasks.find((task) => task.taskId === admission.binding.taskId)?.state
        );
        // Admitted work holds the company however long it runs, and starts no tab's clock.
        yield* ranFor(admission.binding.taskId, 5 * 60_000);
        yield* keeper.housekeeping();
        assert.strictEqual(yield* state, "running");
        yield* admission.release;
        yield* TestClock.adjust(60_000 - 1);
        yield* keeper.housekeeping();
        assert.strictEqual(yield* state, "running");
        yield* TestClock.adjust(1);
        yield* keeper.housekeeping();
        assert.strictEqual(yield* state, "stopped");
        assert.strictEqual((yield* keeper.history(companyId))[0]?.releaseCause, "idle");
        const event = captured.records.find(
          (record) => record.type === "binding" && record.taskId === admission.binding.taskId
        );
        assert.include(event, { releaseCause: "idle", agentOnly: true });
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "runs an agent's minute beside a tab's thirty minutes, never touching it, and releases after both",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle } = yield* setupMemory("two-clocks");
        const captured = yield* recording;
        const keeper = yield* Fleet.make({
          replicaId: "two-clocks-keeper",
          deploymentRevision: "two-clocks",
          automaticHousekeeping: false
        }).pipe(
          Effect.provideService(TaskProvider.TaskProvider, provider),
          Effect.provideService(WideEvents.WideEvents, captured.events)
        );
        const document = yield* Scope.make();
        yield* right.lifecycle.connect(companyId).pipe(Scope.provide(document));
        const bound = yield* right.ensureBinding(companyId);
        const state = Effect.map(
          provider.list,
          (tasks) => tasks.find((task) => task.taskId === bound.taskId)?.state
        );
        const agentCall = Effect.flatMap(
          left.lifecycle.acquire(companyId, bundle.patchId, "agent"),
          (admission) => admission.release
        );
        // A call while the tab holds the task runs on it.
        yield* agentCall;
        yield* TestClock.adjust(2 * 60_000);
        yield* keeper.housekeeping();
        assert.strictEqual(yield* state, "running");
        // The tab lets go, and the next pass starts its thirty minutes; an agent calls near their end.
        yield* Scope.close(document, Exit.void);
        yield* keeper.housekeeping();
        yield* TestClock.adjust(29 * 60_000 + 30_000);
        yield* agentCall;
        yield* TestClock.adjust(30_000);
        yield* keeper.housekeeping();
        assert.strictEqual(yield* state, "running");
        // Had the call restarted the tab's clock, the company would stay another half hour.
        yield* TestClock.adjust(30_000 - 1);
        yield* keeper.housekeeping();
        assert.strictEqual(yield* state, "running");
        yield* TestClock.adjust(1);
        yield* keeper.housekeeping();
        assert.strictEqual(yield* state, "stopped");
        const event = captured.records.find(
          (record) => record.type === "binding" && record.taskId === bound.taskId
        );
        assert.include(event, { releaseCause: "idle", agentOnly: false });
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "runs the minute from a call that settles on a binding a deployment replaced while it ran",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle } = yield* setupMemory("replaced");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "agent");
        const next = yield* Fleet.make({
          replicaId: "replaced-next",
          deploymentRevision: "replaced-next",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.isTrue(yield* next.stageDeployment("replaced-next"));
        yield* next.housekeeping();
        assert.isTrue(yield* next.promoteDeployment("replaced-next"));
        yield* next.housekeeping();
        const replacement = yield* next.ensureBinding(companyId);
        assert.notStrictEqual(replacement.taskId, admission.binding.taskId);
        const state = Effect.map(
          provider.list,
          (tasks) => tasks.find((task) => task.taskId === replacement.taskId)?.state
        );
        // The call outlives the minute it inherited, and holds the company while it runs.
        yield* ranFor(admission.binding.taskId, 5 * 60_000);
        yield* ranFor(replacement.taskId, 5 * 60_000);
        yield* next.housekeeping();
        assert.strictEqual(yield* state, "running");
        yield* admission.release;
        yield* next.housekeeping();
        yield* TestClock.adjust(60_000 - 1);
        yield* next.housekeeping();
        assert.strictEqual(yield* state, "running");
        yield* TestClock.adjust(1);
        yield* next.housekeeping();
        assert.strictEqual(yield* state, "stopped");
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "runs a settling call's minute on the binding that replaced its own as it settled",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, provider, left, bundle } = yield* setupMemory("handoff");
        const store = yield* FleetStore.make;
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "agent");
        yield* ranFor(admission.binding.taskId, 5 * 60_000);
        const next = yield* Fleet.make({
          replicaId: "handoff-next",
          deploymentRevision: "handoff-next",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.isTrue(yield* next.stageDeployment("handoff-next"));
        yield* next.housekeeping();
        assert.isTrue(yield* next.promoteDeployment("handoff-next"));
        // A replacement is committing as the call settles, so the settlement's update waits on the
        // fenced row and its snapshot can't see the new one.
        const started = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const replacing = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const replaced = yield* store.replaceDeploymentBinding(
                "handoff-next",
                yield* Clock.currentTimeMillis
              );
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(commit);
              return replaced!;
            })
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const settling = yield* admission.release.pipe(Effect.forkChild);
        yield* lockWait("the settlement waits on the replacement's fence");
        yield* Deferred.succeed(commit, undefined);
        const replaced = yield* Fiber.join(replacing);
        yield* Fiber.join(settling);
        assert.deepStrictEqual(
          yield* sql`SELECT agent_activity_at FROM execution_bindings
          WHERE binding_id = ${replaced.replacement.bindingId}`,
          [{ agent_activity_at: yield* Clock.currentTimeMillis }]
        );
      }).pipe(Effect.scoped)
  );

  it.effect("runs a settling call's minute before it lets go of the binding", () =>
    Effect.gen(function* () {
      const { companyId, provider, left, right, bundle } = yield* setupMemory("settling");
      const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "agent");
      const state = Effect.map(
        provider.list,
        (tasks) => tasks.find((task) => task.taskId === admission.binding.taskId)?.state
      );
      // The call ran past its protection and the minute counted from its start.
      yield* ranFor(admission.binding.taskId, 10 * 60_000);
      // Another host's pass lands before each statement the release sends, so one lands as soon
      // as the call lets go of the binding.
      let passes = 0;
      let passing = false;
      const passFirst: Statement.Transformer = (statement) =>
        passing || !/^\s*UPDATE execution_bindings/.test(statement.compile()[0])
          ? Effect.succeed(statement)
          : Effect.sync(() => {
              passing = true;
              passes++;
            }).pipe(
              Effect.andThen(right.housekeeping()),
              Effect.ensuring(
                Effect.sync(() => {
                  passing = false;
                })
              ),
              Effect.orDie,
              Effect.as(statement)
            );
      yield* admission.release.pipe(Effect.provideService(Statement.CurrentTransformer, passFirst));
      assert.isAtLeast(passes, 1);
      assert.strictEqual(yield* state, "running");
      yield* TestClock.adjust(60_000);
      yield* right.housekeeping();
      assert.strictEqual(yield* state, "stopped");
    }).pipe(Effect.scoped)
  );

  it.effect("starts a tab's thirty minutes when it leaves, whatever agent work is in flight", () =>
    Effect.gen(function* () {
      const { companyId, provider, left, right, bundle } = yield* setupMemory("tab-leaves");
      const document = yield* Scope.make();
      yield* right.lifecycle.connect(companyId).pipe(Scope.provide(document));
      const bound = yield* right.ensureBinding(companyId);
      const state = Effect.map(
        provider.list,
        (tasks) => tasks.find((task) => task.taskId === bound.taskId)?.state
      );
      const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "agent");
      // The tab leaves while the agent's call runs, and a pass sees it gone.
      yield* Scope.close(document, Exit.void);
      yield* left.housekeeping();
      yield* admission.release;
      yield* TestClock.adjust(30 * 60_000 - 1);
      yield* left.housekeeping();
      assert.strictEqual(yield* state, "running");
      yield* TestClock.adjust(1);
      yield* left.housekeeping();
      assert.strictEqual(yield* state, "stopped");
    }).pipe(Effect.scoped)
  );

  it.effect("lets go of the binding when a settled call's clock can't be run", () =>
    Effect.gen(function* () {
      const { companyId, provider, left, bundle } = yield* setupMemory("clock-fails");
      const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "agent");
      const state = Effect.map(
        provider.list,
        (tasks) => tasks.find((task) => task.taskId === admission.binding.taskId)?.state
      );
      const lost: Statement.Transformer = (statement) =>
        /^\s*UPDATE execution_bindings\s+SET agent_activity_at/.test(statement.compile()[0])
          ? Effect.die("The connection was lost.")
          : Effect.succeed(statement);
      yield* admission.release.pipe(Effect.provideService(Statement.CurrentTransformer, lost));
      // It keeps its crash protection to the deadline, then idles out as a crashed call does.
      yield* TestClock.adjust(65_000);
      yield* left.housekeeping();
      assert.strictEqual(yield* state, "stopped");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "starts a document's thirty minutes no earlier than the first pass to find it gone",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, provider, left, bundle } = yield* setupMemory("vanished");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        yield* admission.release;
        const state = Effect.map(
          provider.list,
          (tasks) => tasks.find((task) => task.taskId === admission.binding.taskId)?.state
        );
        // A document held the task for 35 minutes, then its host stopped without letting go.
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE execution_bindings SET last_activity_at = ${now - 35 * 60_000}
          WHERE task_id = ${admission.binding.taskId}`;
        yield* left.housekeeping();
        assert.strictEqual(yield* state, "running");
        yield* TestClock.adjust(30 * 60_000 - 1);
        yield* left.housekeeping();
        assert.strictEqual(yield* state, "running");
        yield* TestClock.adjust(1);
        yield* left.housekeeping();
        assert.strictEqual(yield* state, "stopped");
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "prewarms a spare only while another stays ready, and lets a task nobody used go at once",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, provider, left, right, bundle } = yield* setupMemory("prewarm");
        const other = `${companyId}_other`;
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${other}, 'fleet-prewarm-other', 'Fleet test')`;
        const spares = sql<{
          total: number;
        }>`SELECT count(*)::integer AS total FROM execution_tasks WHERE state = 'spare'`;
        // A prewarm's work never claims: its prewarm claimed what it could.
        const unbound = yield* left.lifecycle
          .acquire(companyId, bundle.patchId, "prewarm")
          .pipe(Effect.flip);
        assert.strictEqual(unbound.code, "busy");
        assert.strictEqual((yield* spares)[0]!.total, 2);
        const held = yield* Scope.make();
        const prewarmed = yield* left.lifecycle.prewarm(companyId).pipe(Scope.provide(held));
        assert.strictEqual(prewarmed.found, "spare");
        // The last spare stays for an open that can't wait.
        const refused = yield* Scope.make();
        const full = yield* right.lifecycle.prewarm(other).pipe(Scope.provide(refused));
        assert.strictEqual(full.found, "full");
        yield* Scope.close(refused, Exit.void);
        assert.strictEqual((yield* spares)[0]!.total, 1);
        const again = yield* Scope.make();
        const bound = yield* right.lifecycle.prewarm(companyId).pipe(Scope.provide(again));
        assert.strictEqual(bound.found, "bound");
        yield* Scope.close(again, Exit.void);
        // Its work runs neither clock.
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "prewarm");
        yield* admission.release;
        assert.deepStrictEqual(
          yield* sql`SELECT last_activity_at, agent_activity_at FROM execution_bindings
            WHERE company_id = ${companyId} AND state = 'active'`,
          [{ last_activity_at: 0, agent_activity_at: 0 }]
        );
        const state = Effect.map(
          provider.list,
          (tasks) => tasks.find((task) => task.taskId === admission.binding.taskId)?.state
        );
        yield* TestClock.adjust(10 * 60_000);
        yield* left.housekeeping();
        assert.strictEqual(yield* state, "running");
        assert.isFalse(yield* prewarmed.followed);
        yield* Scope.close(held, Exit.void);
        yield* left.housekeeping();
        assert.strictEqual(yield* state, "stopped");
        const history = (yield* left.history(companyId))[0]!;
        assert.strictEqual(history.releaseCause, "unused");
        assert.isNull(history.agentOnly);
      }).pipe(Effect.scoped, Effect.provide(quietActivity)),
    30_000
  );

  it.effect("never prewarms a spare the fleet budget has no room to replace", () =>
    Effect.gen(function* () {
      const { sql, companyId, left } = yield* setupMemory("prewarm-budget");
      // Both spares are ready, and they are all the budget allows.
      const live = yield* sql<{
        total: number;
      }>`SELECT count(*)::integer AS total FROM execution_tasks WHERE state = 'spare'`;
      assert.strictEqual(live[0]!.total, 2);
      const held = yield* Scope.make();
      assert.strictEqual(
        (yield* left.lifecycle.prewarm(companyId).pipe(Scope.provide(held))).found,
        "full"
      );
      yield* Scope.close(held, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(fleetBudget))
  );

  it.effect("keeps a prewarmed task someone opened on the documents' clock", () =>
    Effect.gen(function* () {
      const { companyId, provider, left } = yield* setupMemory("prewarm-opened");
      const held = yield* Scope.make();
      const prewarmed = yield* left.lifecycle.prewarm(companyId).pipe(Scope.provide(held));
      const document = yield* Scope.make();
      yield* left.lifecycle.connect(companyId).pipe(Scope.provide(document));
      assert.isTrue(yield* prewarmed.followed);
      const bound = yield* left.ensureBinding(companyId);
      const state = Effect.map(
        provider.list,
        (tasks) => tasks.find((task) => task.taskId === bound.taskId)?.state
      );
      yield* Scope.close(document, Exit.void);
      yield* Scope.close(held, Exit.void);
      yield* left.housekeeping();
      yield* TestClock.adjust(30 * 60_000 - 1);
      yield* left.housekeeping();
      assert.strictEqual(yield* state, "running");
      yield* TestClock.adjust(1);
      yield* left.housekeeping();
      assert.strictEqual(yield* state, "stopped");
      const history = (yield* left.history(companyId))[0]!;
      assert.strictEqual(history.releaseCause, "idle");
      assert.isFalse(history.agentOnly);
    }).pipe(Effect.scoped)
  );

  it.effect("holds a used task through a prewarm without restarting its documents' window", () =>
    Effect.gen(function* () {
      const { companyId, provider, left, bundle } = yield* setupMemory("prewarm-defers");
      const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
      yield* admission.release;
      const state = Effect.map(
        provider.list,
        (tasks) => tasks.find((task) => task.taskId === admission.binding.taskId)?.state
      );
      // The window starts at the first pass to find no document, and a prewarm doesn't move it.
      yield* left.housekeeping();
      yield* TestClock.adjust(29 * 60_000);
      const held = yield* Scope.make();
      const prewarmed = yield* left.lifecycle.prewarm(companyId).pipe(Scope.provide(held));
      assert.strictEqual(prewarmed.found, "bound");
      yield* TestClock.adjust(2 * 60_000);
      yield* left.housekeeping();
      assert.strictEqual(yield* state, "running");
      yield* Scope.close(held, Exit.void);
      yield* left.housekeeping();
      assert.strictEqual(yield* state, "stopped");
      assert.strictEqual((yield* left.history(companyId))[0]!.releaseCause, "idle");
    }).pipe(Effect.scoped, Effect.provide(quietActivity))
  );

  it.effect(
    "says how a call found its company's server and how long it waited, a refused wait included",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle, sql } = yield* setupMemory("found", false);
        const captured = yield* recording;
        const call = (company: string, host = left) =>
          Effect.gen(function* () {
            const exit = yield* captured.events
              .withEvent(
                { type: "request" },
                Effect.flatMap(
                  host.lifecycle.acquire(company, bundle.patchId, "agent"),
                  (admission) => admission.release
                )
              )
              .pipe(Effect.exit);
            const event = yield* captured.take;
            if (event.type !== "request") return assert.fail(`a ${event.type} event`);
            return {
              found: event.companyBind,
              waitedMs: event.bindWaitMs,
              refused: Exit.isFailure(exit)
            };
          });
        // The pool starts empty, so the first call waits for a launched task.
        assert.include(yield* phase("first call", call(companyId)), {
          found: "launch",
          refused: false
        });
        assert.deepStrictEqual(yield* call(companyId), {
          found: "bound",
          waitedMs: 0,
          refused: false
        });
        // Another company takes the launch's other spare, leaving the pool empty.
        const other = "cmp_fleet_found_other";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${other}, ${other}, 'Fleet found')`;
        assert.include(yield* call(other), { found: "spare", refused: false });
        // A host whose launch never comes refuses the next cold call at the end of the bind wait.
        const stalled = yield* Fleet.make({
          replicaId: "found-stalled",
          deploymentRevision: "found",
          automaticHousekeeping: false
        }).pipe(
          Effect.provideService(
            TaskProvider.TaskProvider,
            TaskProvider.TaskProvider.of({ ...provider, start: () => Effect.never })
          )
        );
        const cold = "cmp_fleet_found_cold";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${cold}, ${cold}, 'Fleet cold')`;
        const refused = yield* call(cold, stalled).pipe(Effect.forkChild);
        // The wait arms once the call's reads land, so the clock moves until it gives up.
        const gaveUp = Effect.gen(function* () {
          while (refused.pollUnsafe() === undefined) {
            yield* TestClock.adjust(500);
            yield* TestClock.withLive(Effect.sleep(5));
          }
          return yield* Fiber.join(refused);
        });
        const refusal = yield* phase("refused call", gaveUp);
        assert.include(refusal, { found: "launch", refused: true });
        // The call arms its wait just after it reads the clock; a step this loop takes between
        // the two lands the wait one step late.
        assert.oneOf(refusal.waitedMs, [40_000, 40_500]);
        // A call whose agent goes away while it waits says so too.
        const gone = "cmp_fleet_found_gone";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${gone}, ${gone}, 'Fleet gone')`;
        const abandoned = yield* captured.events
          .withEvent({ type: "request" }, stalled.lifecycle.acquire(gone, bundle.patchId, "agent"))
          .pipe(Effect.forkChild);
        for (let step = 0; step < 10; step++) {
          yield* TestClock.adjust(500);
          yield* TestClock.withLive(Effect.sleep(5));
        }
        yield* Fiber.interrupt(abandoned);
        const event = yield* captured.take;
        if (event.type !== "request") return assert.fail(`a ${event.type} event`);
        assert.include(event, { outcome: "interrupted", companyBind: "launch" });
        assert.isAbove(event.bindWaitMs ?? 0, 0);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "says how a stream connect found its company's server and how long it waited, a refused or interrupted wait included",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, sql } = yield* setupMemory("connect-found", false);
        const captured = yield* recording;
        const connect = (company: string, host = left) =>
          Effect.gen(function* () {
            const exit = yield* captured.events
              .withEvent(
                { type: "stream", tier: 2 },
                host.lifecycle.connect(company).pipe(Effect.scoped)
              )
              .pipe(Effect.exit);
            const event = yield* captured.take;
            if (event.type !== "stream") return assert.fail(`a ${event.type} event`);
            return {
              found: event.companyBind,
              waitedMs: event.bindWaitMs,
              exit
            };
          });
        // The pool starts empty, so the first open waits for a launched task.
        const first = yield* phase("first connect", connect(companyId));
        assert.include(first, { found: "launch" });
        assert.isTrue(Exit.isSuccess(first.exit));
        // The company is now bound, so the next open finds it warm.
        const warm = yield* connect(companyId);
        assert.include(warm, { found: "bound", waitedMs: 0 });
        assert.isTrue(Exit.isSuccess(warm.exit));
        // Another company claims the remaining ready spare.
        const other = "cmp_fleet_connect_found_other";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${other}, ${other}, 'Fleet connect found')`;
        const spare = yield* connect(other);
        assert.include(spare, { found: "spare" });
        assert.isTrue(Exit.isSuccess(spare.exit));
        // A host whose launch never arrives refuses the next cold open at execution.pool.wait.
        const stalled = yield* Fleet.make({
          replicaId: "connect-found-stalled",
          deploymentRevision: "connect-found",
          automaticHousekeeping: false
        }).pipe(
          Effect.provideService(
            TaskProvider.TaskProvider,
            TaskProvider.TaskProvider.of({ ...provider, start: () => Effect.never })
          )
        );
        const cold = "cmp_fleet_connect_found_cold";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${cold}, ${cold}, 'Fleet connect cold')`;
        const refused = yield* connect(cold, stalled).pipe(Effect.forkChild);
        const gaveUp = Effect.gen(function* () {
          while (refused.pollUnsafe() === undefined) {
            yield* TestClock.adjust(500);
            yield* TestClock.withLive(Effect.sleep(5));
          }
          return yield* Fiber.join(refused);
        });
        const refusal = yield* phase("refused connect", gaveUp);
        assert.include(refusal, { found: "launch" });
        assert.isTrue(Exit.isFailure(refusal.exit));
        // The last 500 ms step can cross the 40 s pool timeout by one tick.
        assert.oneOf(refusal.waitedMs, [40_000, 40_500]);
        // An interrupted wait after missing a claim (launch phase) still records companyBind and bindWaitMs.
        const gone = "cmp_fleet_connect_found_gone";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${gone}, ${gone}, 'Fleet connect gone')`;
        let claimAttempts = 0;
        const secondAttempt = yield* Deferred.make<void>();
        const watchClaim: Statement.Transformer = (statement) =>
          /pg_advisory_xact_lock/.test(statement.compile()[0])
            ? Effect.suspend(() => {
                claimAttempts++;
                return claimAttempts >= 2
                  ? Deferred.succeed(secondAttempt, undefined).pipe(Effect.as(statement))
                  : Effect.succeed(statement);
              })
            : Effect.succeed(statement);
        const abandoned = yield* captured.events
          .withEvent(
            { type: "stream", tier: 2 },
            stalled.lifecycle
              .connect(gone)
              .pipe(Effect.provideService(Statement.CurrentTransformer, watchClaim), Effect.scoped)
          )
          .pipe(Effect.forkChild);
        // Wait until the first claim misses (marking `launch`) and the second poll begins.
        yield* phase(
          "connect enters launch wait",
          Effect.gen(function* () {
            while (claimAttempts < 2) {
              yield* TestClock.adjust(50);
              yield* TestClock.withLive(Effect.sleep(5));
            }
            yield* Deferred.await(secondAttempt);
          })
        );
        yield* TestClock.adjust(1_500);
        yield* Fiber.interrupt(abandoned);
        const event = yield* captured.take;
        if (event.type !== "stream") return assert.fail(`a ${event.type} event`);
        assert.include(event, { outcome: "interrupted", companyBind: "launch" });
        assert.isAtLeast(event.bindWaitMs ?? 0, 1_500);
        // An early cancellation before the bind path is known (during initial lookup OR while the
        // first claim's per-company advisory lock is pending) still records bindWaitMs without companyBind.
        const early = "cmp_fleet_connect_found_early";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${early}, ${early}, 'Fleet connect early')`;
        const stalledLookup = yield* Deferred.make<void>();
        const blockLookup: Statement.Transformer = (statement) =>
          /FROM execution_bindings\b/.test(statement.compile()[0])
            ? Deferred.succeed(stalledLookup, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.as(statement)
              )
            : Effect.succeed(statement);
        const cancelledEarly = yield* captured.events
          .withEvent(
            { type: "stream", tier: 2 },
            stalled.lifecycle
              .connect(early)
              .pipe(Effect.provideService(Statement.CurrentTransformer, blockLookup), Effect.scoped)
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(stalledLookup);
        yield* TestClock.adjust(2_000);
        yield* Fiber.interrupt(cancelledEarly);
        const earlyEvent = yield* captured.take;
        if (earlyEvent.type !== "stream") return assert.fail(`a ${earlyEvent.type} event`);
        assert.include(earlyEvent, { outcome: "interrupted", bindWaitMs: 2_000 });
        assert.notProperty(earlyEvent, "companyBind");
        const claimBlocked = "cmp_fleet_connect_claim_blocked";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${claimBlocked}, ${claimBlocked}, 'Fleet claim blocked')`;
        const stalledClaim = yield* Deferred.make<void>();
        const blockFirstClaim: Statement.Transformer = (statement) =>
          /pg_advisory_xact_lock/.test(statement.compile()[0])
            ? Deferred.succeed(stalledClaim, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.as(statement)
              )
            : Effect.succeed(statement);
        const cancelledClaim = yield* captured.events
          .withEvent(
            { type: "stream", tier: 2 },
            stalled.lifecycle
              .connect(claimBlocked)
              .pipe(
                Effect.provideService(Statement.CurrentTransformer, blockFirstClaim),
                Effect.scoped
              )
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(stalledClaim);
        yield* TestClock.adjust(1_250);
        yield* Fiber.interrupt(cancelledClaim);
        const claimEvent = yield* captured.take;
        if (claimEvent.type !== "stream") return assert.fail(`a ${claimEvent.type} event`);
        assert.include(claimEvent, { outcome: "interrupted", bindWaitMs: 1_250 });
        assert.notProperty(claimEvent, "companyBind");
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "logs a single-line fleet budget exhaustion warning rate-limited per housekeeping interval, never on lease loss or retired revision",
    () =>
      Effect.gen(function* () {
        const logs: Array<{ readonly message: unknown; readonly level: string }> = [];
        const captureLogs = Logger.layer([
          Logger.make((entry) => {
            logs.push({ message: entry.message, level: entry.logLevel });
          })
        ]);
        const budgetWarnings = () =>
          logs
            .filter((entry) => entry.level === "Warn")
            .map((entry) =>
              Array.isArray(entry.message) && entry.message.length === 1
                ? entry.message[0]
                : entry.message
            )
            .filter(
              (message): message is string =>
                typeof message === "string" &&
                message.startsWith("Execution fleet budget exhausted")
            );
        const { companyId, bundle, left, sql } = yield* setupMemory("budget-warn");
        const store = yield* FleetStore.make;
        // Budget is 2 and minimumSpares is 2; binding one company leaves 1 spare and 0 headroom.
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        yield* left.housekeeping().pipe(Effect.provide(captureLogs));
        const warnings = budgetWarnings();
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(
          warnings[0],
          "Execution fleet budget exhausted revision=budget-warn size=full budget=2 target=2 spares=1"
        );
        assert.notInclude(warnings[0]!, "\n");
        // Immediate follow-up pass within the housekeeping interval is rate-limited.
        yield* left.housekeeping().pipe(Effect.provide(captureLogs));
        assert.strictEqual(budgetWarnings().length, 1);
        // Once the housekeeping interval elapses, sustained exhaustion logs again.
        yield* TestClock.adjust(5_000);
        yield* left.housekeeping().pipe(Effect.provide(captureLogs));
        assert.strictEqual(budgetWarnings().length, 2);
        // Direct store.reserve distinguishes lease loss and retired revision from budget exhaustion
        // in one snapshot and returns the live spare count for the revision.
        yield* TestClock.adjust(15_000);
        const now = yield* Clock.currentTimeMillis;
        assert.deepStrictEqual(
          yield* store.reserve(
            "res-lease-lost",
            "budget-warn",
            TaskProvider.full,
            "other-owner",
            999,
            now,
            2
          ),
          { outcome: "lease_lost" }
        );
        const lease = (yield* store.lease("budget-warn-direct", "budget-warn", now, 15_000))!;
        assert.deepStrictEqual(
          yield* store.reserve(
            "res-budget",
            "budget-warn",
            TaskProvider.full,
            "budget-warn-direct",
            lease.leaseEpoch,
            now,
            2
          ),
          { outcome: "budget", spares: 1 }
        );
        assert.deepStrictEqual(
          yield* store.reserve(
            "res-retired",
            "missing-revision",
            TaskProvider.full,
            "budget-warn-direct",
            lease.leaseEpoch,
            now,
            10
          ),
          { outcome: "retired" }
        );
        yield* sql`DELETE FROM execution_housekeeping WHERE owner_id = 'budget-warn-direct'`;
        yield* admission.release;
        // Advance past the warning rate-limit window before testing retired/lease-loss suppression.
        yield* TestClock.adjust(5_000);
        // If the revision is retired right before the reserve CTE, replenish must not log a budget warning.
        logs.length = 0;
        let retiredOnce = false;
        const retireBeforeReserve: Statement.Transformer = (statement) =>
          retiredOnce || !/INSERT INTO execution_tasks\b/.test(statement.compile()[0])
            ? Effect.succeed(statement)
            : Effect.sync(() => {
                retiredOnce = true;
              }).pipe(
                Effect.andThen(store.retireDeployment("budget-warn").pipe(Effect.orDie)),
                Effect.as(statement)
              );
        yield* left
          .housekeeping()
          .pipe(
            Effect.provide(captureLogs),
            Effect.provideService(Statement.CurrentTransformer, retireBeforeReserve),
            Effect.result
          );
        assert.isTrue(retiredOnce);
        assert.strictEqual(budgetWarnings().length, 0);
        // Re-register and expire the lease right before reserve's FOR UPDATE lease check: no budget warning.
        yield* sql`UPDATE execution_deployments SET retired = false WHERE revision = 'budget-warn'`;
        yield* sql`UPDATE execution_rollout SET current_revision = 'budget-warn' WHERE singleton`;
        yield* TestClock.adjust(5_000);
        let expiredOnce = false;
        const expireBeforeReserve: Statement.Transformer = (statement) =>
          expiredOnce ||
          !/^\s*SELECT lease_epoch AS "leaseEpoch" FROM execution_housekeeping\b/.test(
            statement.compile()[0]
          )
            ? Effect.succeed(statement)
            : Effect.sync(() => {
                expiredOnce = true;
              }).pipe(
                Effect.andThen(
                  sql`UPDATE execution_housekeeping SET expires_at = 0`.pipe(Effect.orDie)
                ),
                Effect.as(statement)
              );
        yield* left
          .housekeeping()
          .pipe(
            Effect.provide(captureLogs),
            Effect.provideService(Statement.CurrentTransformer, expireBeforeReserve),
            Effect.result
          );
        assert.isTrue(expiredOnce);
        assert.strictEqual(budgetWarnings().length, 0);
      }).pipe(Effect.scoped, Effect.provide(fleetBudget)),
    30_000
  );

  it.effect(
    "allows only the leased replica to replenish, respects budget, and stops unknown provider tasks",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, bundle, left, right, sql } = yield* setupMemory("budget");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        assert.isTrue(yield* left.housekeeping());
        assert.isFalse(yield* right.housekeeping());
        assert.strictEqual(
          (yield* provider.list).filter((task) => task.state === "running").length,
          2
        );
        yield* provider.start({
          taskId: "unrecorded-task",
          deploymentRevision: "budget",
          size: TaskProvider.full
        });
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
        // The interval replenishment, armed when the pass began, launches fresh spare(s) past the failed start.
        const fourth = yield* owner.ensureBinding(fourthCompany).pipe(Effect.forkChild);
        yield* TestClock.adjust(5_000);
        const claimed = yield* phase("fourth company claims", Fiber.join(fourth), pass);
        assert.include(launched.slice(2), claimed.taskId);
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
        yield* provider.start({
          taskId: "isolated-stubborn",
          deploymentRevision: "isolated",
          size: TaskProvider.full
        });
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

  it.effect(
    "admits and releases a warm call in six platform statements, none in a transaction",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, left, bundle } = yield* setupMemory("statements");
        yield* (yield* left.lifecycle.acquire(companyId, bundle.patchId, "page")).release;
        yield* TestClock.adjust(1_000);
        const now = yield* Clock.currentTimeMillis;
        const call = yield* recordStatements(
          Effect.gen(function* () {
            const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
            yield* admission.release;
          })
        );
        // The pause upsert and read, the warm read and `protect`, then the caller's clock while it
        // still holds the binding, and the release.
        const expected = [
          /^INSERT INTO execution_breakers /,
          /^SELECT paused_until AS "pausedUntil" FROM execution_breakers /,
          /^SELECT .* FROM execution_bindings WHERE company_id = \$1 AND state = 'active' AND EXISTS /,
          /^UPDATE execution_bindings SET protected_until = GREATEST/,
          /^UPDATE execution_bindings SET last_activity_at = GREATEST\(last_activity_at, \$1\) WHERE company_id = /,
          /^UPDATE execution_bindings SET protected_until = 0 WHERE binding_id = /
        ];
        assert.lengthOf(call.statements, expected.length);
        call.statements.forEach(({ text, inTransaction }, index) => {
          assert.match(text, expected[index]!);
          assert.isFalse(inTransaction, text);
        });
        assert.deepStrictEqual(
          yield* sql`SELECT protected_until, last_activity_at, agent_activity_at FROM execution_bindings
          WHERE company_id = ${companyId} AND state = 'active'`,
          [{ protected_until: 0, last_activity_at: now, agent_activity_at: 0 }]
        );
        // An agent's call is the same statements on its own clock.
        yield* TestClock.adjust(1_000);
        const agent = yield* recordStatements(
          Effect.flatMap(
            left.lifecycle.acquire(companyId, bundle.patchId, "agent"),
            (admission) => admission.release
          )
        );
        assert.lengthOf(agent.statements, expected.length);
        assert.match(
          agent.statements[4]!.text,
          /^UPDATE execution_bindings SET agent_activity_at = GREATEST\(agent_activity_at, \$1\)/
        );
        assert.deepStrictEqual(
          yield* sql`SELECT last_activity_at, agent_activity_at FROM execution_bindings
          WHERE company_id = ${companyId} AND state = 'active'`,
          [{ last_activity_at: now, agent_activity_at: now + 1_000 }]
        );
        // A settlement that lands after a later one never moves its clock back.
        yield* (yield* FleetStore.make).touch(companyId, now, "agent");
        assert.deepStrictEqual(
          yield* sql`SELECT agent_activity_at FROM execution_bindings
          WHERE company_id = ${companyId} AND state = 'active'`,
          [{ agent_activity_at: now + 1_000 }]
        );
        // A keepalive touch reads the pause, two statements, and the binding.
        const touch = yield* recordStatements(
          left.lifecycle.touch({
            companyId,
            patchId: bundle.patchId,
            versionId: bundle.versionId,
            sha256: bundle.sha256
          })
        );
        assert.strictEqual(touch.result.outcome, "absent");
        assert.lengthOf(touch.statements, 3);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "keeps protection while another call holds the binding and clears it on a draining binding at the last release",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, left, right, bundle } = yield* setupMemory("release");
        const first = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        const second = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        const row = (taskId: string) =>
          sql<{
            state: string;
            protected_until: number;
            last_activity_at: number;
          }>`SELECT state, protected_until, last_activity_at FROM execution_bindings WHERE task_id = ${taskId}`.pipe(
            Effect.map((rows) => rows[0]!)
          );
        yield* first.release;
        assert.isAbove((yield* row(first.binding.taskId)).protected_until, 0);
        // Drained while held: new work binds fresh, and the stop waits for the held call.
        assert.isTrue(yield* right.releaseCompany(companyId));
        const fresh = yield* right.ensureBinding(companyId);
        assert.notStrictEqual(fresh.taskId, first.binding.taskId);
        yield* TestClock.adjust(1_000);
        yield* second.release;
        assert.include(yield* row(first.binding.taskId), { state: "stopping", protected_until: 0 });
        assert.strictEqual(
          (yield* row(fresh.taskId)).last_activity_at,
          yield* Clock.currentTimeMillis
        );
        yield* left.housekeeping();
        assert.strictEqual((yield* row(first.binding.taskId)).state, "stopped");
      }).pipe(Effect.scoped)
  );

  it.effect("never admits the epoch an adoption replaced between the warm read and the hold", () =>
    Effect.gen(function* () {
      const { sql, companyId, left, bundle } = yield* setupMemory("adopt-race");
      const captured = yield* recording;
      const store = yield* FleetStore.make;
      const warm = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
      yield* warm.release;
      const current = (yield* store.findTask(warm.binding.taskId))[0]!;
      const adopting = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      // The adoption keeps the binding's exclusive lock until it commits, so the call's warm
      // read still sees the old epoch while its hold waits behind the lock.
      const adoption = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const adopted = yield* store.adopt(
              current,
              "adopt-race-right",
              yield* Clock.currentTimeMillis
            );
            yield* Deferred.succeed(adopting, undefined);
            yield* Deferred.await(commit);
            return adopted[0]!;
          })
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(adopting);
      const call = yield* captured.events
        .withEvent(
          { type: "request", tier: 2 },
          left.lifecycle.acquire(companyId, bundle.patchId, "page")
        )
        .pipe(Effect.forkChild);
      yield* lockWait("the call's hold waits behind the adoption");
      yield* Deferred.succeed(commit, undefined);
      const adopted = yield* Fiber.join(adoption);
      assert.isAbove(adopted.bindingEpoch, warm.binding.bindingEpoch);
      // `protect` refuses the old epoch, and the claim loop finishes binding the adopted one.
      const admission = yield* Fiber.join(call);
      const event = yield* captured.take;
      if (event.type !== "request") return assert.fail(`a ${event.type} event`);
      assert.strictEqual(event.companyBind, "spare");
      assert.deepStrictEqual(admission.binding, {
        taskId: warm.binding.taskId,
        bindingEpoch: adopted.bindingEpoch
      });
      yield* admission.release;
    }).pipe(Effect.scoped)
  );

  it.effect(
    "skips a warm binding whose deployment retired, and the claim loop fences it before admitting a fresh task",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, left, bundle } = yield* setupMemory("retired");
        const captured = yield* recording;
        const old = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        yield* old.release;
        const next = yield* Fleet.make({
          replicaId: "retired-next",
          deploymentRevision: "retired-next",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.isTrue(yield* next.stageDeployment("retired-next"));
        yield* next.housekeeping();
        assert.isTrue(yield* next.promoteDeployment("retired-next"));
        // Retired without the drain that would fence the binding first.
        yield* sql`UPDATE execution_deployments SET retired = true WHERE revision = 'retired'`;
        const fresh = yield* captured.events.withEvent(
          { type: "request", tier: 2 },
          left.lifecycle.acquire(companyId, bundle.patchId, "page")
        );
        const event = yield* captured.take;
        if (event.type !== "request") return assert.fail(`a ${event.type} event`);
        assert.strictEqual(event.companyBind, "spare");
        assert.notStrictEqual(fresh.binding.taskId, old.binding.taskId);
        const tasks = yield* provider.list;
        assert.strictEqual(
          tasks.find((task) => task.taskId === fresh.binding.taskId)?.deploymentRevision,
          "retired-next"
        );
        assert.strictEqual(
          tasks.find((task) => task.taskId === old.binding.taskId)?.state,
          "stopped"
        );
        assert.strictEqual((yield* left.history(companyId))[0]?.releaseCause, "deployment");
        yield* fresh.release;
      }).pipe(Effect.scoped)
  );

  it.effect(
    "refuses an admission that waited on a breaker trip, and the call already admitted keeps running",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, left, bundle } = yield* setupMemory("trip");
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        const now = yield* Clock.currentTimeMillis;
        const tripped = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        // A report trips the breaker mid-call and holds the row until it commits.
        const trip = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE execution_breakers SET paused_until = ${now + 60_000}
                WHERE company_id = ${companyId} AND patch_id = ${bundle.patchId}`;
              yield* Deferred.succeed(tripped, undefined);
              yield* Deferred.await(commit);
            })
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(tripped);
        const next = yield* left.lifecycle
          .acquire(companyId, bundle.patchId, "page")
          .pipe(Effect.flip, Effect.forkChild);
        yield* lockWait("the next admission waits on the trip");
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(trip);
        assert.include(yield* Fiber.join(next), { code: "patch_paused", retryAfterSeconds: 60 });
        yield* admitted.release;
        yield* TestClock.adjust(60_000);
        yield* (yield* left.lifecycle.acquire(companyId, bundle.patchId, "page")).release;
      }).pipe(Effect.scoped)
  );

  it.effect("admits a call that waited on a newer publish clearing its pause", () =>
    Effect.gen(function* () {
      const { sql, companyId, left, bundle } = yield* setupMemory("publish-reset");
      const store = yield* FleetStore.make;
      const publish = yield* publishedPatch(companyId, bundle.patchId, "fleet-publish-reset");
      yield* publish(1);
      yield* (yield* left.lifecycle.acquire(companyId, bundle.patchId, "page")).release;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE execution_breakers SET paused_until = ${now + 60_000}
        WHERE company_id = ${companyId} AND patch_id = ${bundle.patchId}`;
      yield* publish(2);
      const cleared = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      // Another host's admission sees the publish first; its upsert clears the pause and holds the row.
      const other = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.strictEqual(yield* store.pausedUntil(companyId, bundle.patchId), 0);
            yield* Deferred.succeed(cleared, undefined);
            yield* Deferred.await(commit);
          })
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(cleared);
      const call = yield* left.lifecycle
        .acquire(companyId, bundle.patchId, "page")
        .pipe(Effect.forkChild);
      yield* lockWait("the call waits on the publish's reset");
      yield* Deferred.succeed(commit, undefined);
      yield* Fiber.join(other);
      yield* (yield* Fiber.join(call)).release;
    }).pipe(Effect.scoped)
  );

  it.effect(
    "counts distinct waiting companies in the spare target, collapses duplicates, clears on claim, and respects budget",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, left, right } = yield* setupMemory("waiting-burst");
        const store = yield* FleetStore.make;
        const fill = "cmp_fleet_waiting_burst_fill";
        const waiters = [
          "cmp_fleet_waiting_burst_1",
          "cmp_fleet_waiting_burst_2",
          "cmp_fleet_waiting_burst_3",
          "cmp_fleet_waiting_burst_4"
        ] as const;
        for (const company of [fill, ...waiters])
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet burst')`;
        // Claim both ready spares so the pool starts empty (2 bound tasks live, 5 budget left).
        yield* left.ensureBinding(companyId);
        yield* left.ensureBinding(fill);
        // Hold the housekeeping lease on `left` so `right`'s waiters queue before replenishment.
        const now = yield* Clock.currentTimeMillis;
        assert.isDefined(yield* store.lease("waiting-burst-left", "waiting-burst", now, 15_000));
        const pending = yield* Effect.forEach(waiters, (company) =>
          right.ensureBinding(company).pipe(Effect.forkChild)
        );
        const duplicate = yield* right.ensureBinding(waiters[0]).pipe(Effect.forkChild);
        yield* phase(
          "all four waiting companies record demand",
          Effect.gen(function* () {
            while (true) {
              const rows = yield* sql<{ total: number }>`
                SELECT count(*)::integer AS total FROM execution_pool_waits`;
              if (rows[0]!.total === waiters.length) return;
              yield* TestClock.withLive(Effect.sleep(5));
            }
          })
        );
        const before = yield* store.target(now, 900_000, "waiting-burst", false);
        assert.strictEqual(before.full.waiting, waiters.length);
        // Target is minimumSpares (2) + waiting (4) = 6, capped by the remaining 5 budget slots.
        assert.isTrue(yield* left.housekeeping());
        const settle = <A, E>(fiber: Fiber.Fiber<A, E>) =>
          Effect.gen(function* () {
            while (fiber.pollUnsafe() === undefined) {
              yield* TestClock.adjust(50);
              yield* TestClock.withLive(Effect.sleep(5));
            }
            return yield* Fiber.join(fiber);
          });
        const bindings = yield* phase(
          "waiting companies claim launched spares",
          Effect.forEach(pending, settle)
        );
        const dupBinding = yield* phase("duplicate waiter joins binding", settle(duplicate));
        assert.strictEqual(dupBinding.taskId, bindings[0]!.taskId);
        assert.strictEqual(dupBinding.bindingEpoch, bindings[0]!.bindingEpoch);
        assert.strictEqual(new Set(bindings.map((binding) => binding.taskId)).size, waiters.length);
        assert.strictEqual(
          (yield* provider.list).filter((task) => task.state === "running").length,
          7
        );
        assert.deepStrictEqual(yield* sql`SELECT company_id FROM execution_pool_waits`, []);
        // Follow-up pass with 0 waiting and budget full launches nothing more.
        assert.isTrue(yield* left.housekeeping());
        assert.strictEqual(
          (yield* provider.list).filter((task) => task.state === "running").length,
          7
        );
        // A stale wait row for an already-bound company is cleared when `claim` returns it.
        yield* sql`INSERT INTO execution_pool_waits (company_id, until)
          VALUES (${waiters[0]}, ${(yield* Clock.currentTimeMillis) + 60_000})`;
        const existing = yield* store.claim(
          waiters[0],
          "waiting-burst-right",
          yield* Clock.currentTimeMillis,
          0,
          FleetStore.clocksOf("page", yield* Clock.currentTimeMillis)
        );
        assert.strictEqual(existing?.taskId, bindings[0]!.taskId);
        assert.deepStrictEqual(yield* sql`SELECT company_id FROM execution_pool_waits`, []);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PATCHY_LIMITS_JSON: '{"execution.fleet.budget":7,"execution.pool.spares":2}'
            })
          )
        )
      ),
    30_000
  );

  it.effect(
    "re-records a waiter's demand after another replica's binding is fenced before the next poll",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, left, right } = yield* setupMemory("waiting-interleave");
        const store = yield* FleetStore.make;
        const fill = "cmp_fleet_waiting_interleave_fill";
        const target = "cmp_fleet_waiting_interleave_target";
        for (const company of [fill, target])
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet interleave')`;
        yield* left.ensureBinding(companyId);
        yield* left.ensureBinding(fill);
        const now = yield* Clock.currentTimeMillis;
        assert.isDefined(
          yield* store.lease("waiting-interleave-left", "waiting-interleave", now, 15_000)
        );
        // Track polls on replica A (`right`) with a barrier after a peer claim+fence clears the wait.
        let pollsAfterFence = 0;
        let fencedPeer = false;
        const repolled = yield* Deferred.make<void>();
        const watchPolls: Statement.Transformer = (statement) => {
          const text = statement.compile()[0];
          if (fencedPeer && /execution_pool_waits/.test(text)) {
            pollsAfterFence++;
            return Deferred.succeed(repolled, undefined).pipe(Effect.as(statement));
          }
          return Effect.succeed(statement);
        };
        const waiter = yield* right
          .ensureBinding(target)
          .pipe(Effect.provideService(Statement.CurrentTransformer, watchPolls), Effect.forkChild);
        yield* phase(
          "replica A records initial wait",
          Effect.gen(function* () {
            while (true) {
              const rows = yield* sql`SELECT company_id FROM execution_pool_waits
                WHERE company_id = ${target}`;
              if (rows.length === 1) return;
              yield* TestClock.withLive(Effect.sleep(5));
            }
          })
        );
        // Replica B (`left`) gets a spare, claims it for `target` (deleting the wait row), and then
        // its binding is fenced and stopped before replica A's next poll.
        const spareTask = yield* provider.start({
          taskId: "peer-spare-task",
          deploymentRevision: "waiting-interleave",
          size: TaskProvider.full
        });
        yield* sql`INSERT INTO execution_tasks (task_id, deployment_revision, state, requested_at, started_at, ready_at)
          VALUES (${spareTask.taskId}, 'waiting-interleave', 'spare', ${now}, ${spareTask.startedAt}, ${spareTask.readyAt})`;
        const peerBinding = (yield* store.claim(
          target,
          "waiting-interleave-left",
          now,
          0,
          FleetStore.clocksOf("page", now)
        ))!;
        assert.isDefined(peerBinding);
        assert.deepStrictEqual(yield* sql`SELECT company_id FROM execution_pool_waits`, []);
        yield* store.fence(peerBinding, "deployment");
        yield* store.stopped(spareTask.taskId, now, "deployment");
        fencedPeer = true;
        // Drive replica A's poll loop until the barrier confirms it polled after the fence and its
        // wait row has committed.
        yield* phase(
          "replica A polls again and commits its wait",
          Effect.gen(function* () {
            while (pollsAfterFence === 0) {
              yield* TestClock.adjust(50);
              yield* TestClock.withLive(Effect.sleep(5));
            }
            yield* Deferred.await(repolled);
            while (
              (yield* store.target(
                yield* Clock.currentTimeMillis,
                900_000,
                "waiting-interleave",
                false
              )).full.waiting !== 1
            ) {
              yield* TestClock.withLive(Effect.sleep(5));
            }
          })
        );
        yield* Fiber.interrupt(waiter);
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "reclaims surplus spares from an abandoned burst after grace so a staged revision can promote under a tight budget",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, left, right } = yield* setupMemory("waiting-abandon-old");
        const store = yield* FleetStore.make;
        const fill = "cmp_fleet_waiting_abandon_fill";
        const waiters = [
          "cmp_fleet_waiting_abandon_1",
          "cmp_fleet_waiting_abandon_2",
          "cmp_fleet_waiting_abandon_3",
          "cmp_fleet_waiting_abandon_4"
        ] as const;
        for (const company of [fill, ...waiters])
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet abandon')`;
        // Budget is 6, minimumSpares is 2: 2 bound tasks leave 4 budget slots.
        yield* left.ensureBinding(companyId);
        yield* left.ensureBinding(fill);
        const now = yield* Clock.currentTimeMillis;
        assert.isDefined(
          yield* store.lease("waiting-abandon-old-left", "waiting-abandon-old", now, 15_000)
        );
        // Delay spare starts so all 4 budget slots are reserved while the burst is waiting, then
        // interrupt the waiters before those tasks become ready.
        const releaseStarts = yield* Deferred.make<void>();
        const started = yield* Queue.unbounded<string>();
        const delayedProvider = TaskProvider.TaskProvider.of({
          ...provider,
          start: (input) =>
            Queue.offer(started, input.taskId).pipe(
              Effect.andThen(Deferred.await(releaseStarts)),
              Effect.andThen(provider.start(input))
            )
        });
        const launcher = yield* Fleet.make({
          replicaId: "waiting-abandon-old-left",
          deploymentRevision: "waiting-abandon-old",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, delayedProvider));
        const pending = yield* Effect.forEach(waiters, (company) =>
          right.ensureBinding(company).pipe(Effect.forkChild)
        );
        yield* phase(
          "all four waiters register demand",
          Effect.gen(function* () {
            while (true) {
              const rows = yield* sql<{ total: number }>`
                SELECT count(*)::integer AS total FROM execution_pool_waits`;
              if (rows[0]!.total === waiters.length) return;
              yield* TestClock.withLive(Effect.sleep(5));
            }
          })
        );
        const replenishFiber = yield* launcher.housekeeping().pipe(Effect.forkChild);
        // Wait for all 4 remaining budget slots to start launching (total 6/6 live).
        yield* phase(
          "burst fills all four remaining budget slots",
          Effect.forEach([0, 1, 2, 3], () => Queue.take(started))
        );
        // Callers abandon before the spares become ready.
        yield* Effect.forEach(pending, Fiber.interrupt);
        yield* Deferred.succeed(releaseStarts, undefined);
        assert.isTrue(yield* Fiber.join(replenishFiber));
        // All 4 burst tasks are now ready spares on `old`, filling the 6-task budget completely.
        const readyAfterBurst = yield* sql<{ total: number }>`
          SELECT count(*)::integer AS total FROM execution_tasks
          WHERE deployment_revision = 'waiting-abandon-old' AND state = 'spare'`;
        assert.strictEqual(readyAfterBurst[0]!.total, 4);
        // Stage a new revision; before the 40 s grace window elapses, all 4 burst spares stay warm.
        const candidate = yield* Fleet.make({
          replicaId: "waiting-abandon-candidate",
          deploymentRevision: "waiting-abandon-new",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.isTrue(yield* candidate.stageDeployment("waiting-abandon-new"));
        // Let the previous host's 15 s lease expire while still well inside the 40 s grace window.
        yield* TestClock.adjust(15_000);
        assert.isTrue(yield* candidate.housekeeping());
        const beforeGrace = yield* sql<{ total: number }>`
          SELECT count(*)::integer AS total FROM execution_tasks
          WHERE deployment_revision = 'waiting-abandon-old' AND state = 'spare'`;
        assert.strictEqual(beforeGrace[0]!.total, 4);
        // Expire both the waits and the remaining 25 s of the 40 s grace window after readiness.
        yield* TestClock.adjust(25_000);
        // Pass 1 trims and drains the 2 surplus `old` spares (keeping floor=2) beside replenish;
        // pass 2 sees the freed budget slots and warms `new`'s 2 spares for promotion.
        assert.isTrue(yield* candidate.housekeeping());
        assert.isTrue(yield* candidate.housekeeping());
        assert.isTrue(yield* candidate.promoteDeployment("waiting-abandon-new"));
        const liveByRevision = yield* sql<{ deployment_revision: string; total: number }>`
          SELECT deployment_revision, count(*)::integer AS total
          FROM execution_tasks WHERE state = 'spare'
          GROUP BY deployment_revision ORDER BY deployment_revision`;
        assert.deepStrictEqual(liveByRevision, [
          { deployment_revision: "waiting-abandon-new", total: 2 },
          { deployment_revision: "waiting-abandon-old", total: 2 }
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PATCHY_LIMITS_JSON: '{"execution.fleet.budget":6,"execution.pool.spares":2}'
            })
          )
        )
      ),
    30_000
  );

  it.effect(
    "never trims below the spare floor under a concurrent claim, and lets replenishment use free budget while slow trims drain",
    () =>
      Effect.gen(function* () {
        const { sql, provider, left } = yield* setupMemory("trim-concurrency");
        const store = yield* FleetStore.make;
        const racer = "cmp_fleet_trim_racer";
        yield* sql`INSERT INTO companies(id, handle, name) VALUES (${racer}, ${racer}, 'Fleet racer')`;
        const now = yield* Clock.currentTimeMillis;
        // Start with 3 aged ready spares against floor=2.
        const extra = yield* provider.start({
          taskId: "trim-extra-1",
          deploymentRevision: "trim-concurrency",
          size: TaskProvider.full
        });
        yield* sql`INSERT INTO execution_tasks (task_id, deployment_revision, state, requested_at, started_at, ready_at)
          VALUES (${extra.taskId}, 'trim-concurrency', 'spare', ${now + 10}, ${extra.startedAt}, ${extra.readyAt})`;
        yield* TestClock.adjust(40_000);
        // A concurrent claim lands after `target` measures 3 ready spares and before `trimSpares`
        // runs: `trimSpares` locks only the 2 remaining spares and must trim 0 of them.
        const measured = yield* store.target(
          yield* Clock.currentTimeMillis,
          900_000,
          "trim-concurrency",
          false
        );
        assert.strictEqual(measured.full.readySpares, 3);
        const claimed = yield* store.claim(
          racer,
          "trim-racer-host",
          yield* Clock.currentTimeMillis,
          0,
          FleetStore.clocksOf("page", yield* Clock.currentTimeMillis)
        );
        assert.isDefined(claimed);
        const trimmedAfterRace = yield* store.trimSpares(
          "trim-concurrency",
          TaskProvider.full,
          2,
          (yield* Clock.currentTimeMillis) - 40_000
        );
        assert.deepStrictEqual(trimmedAfterRace, []);
        const remainingSpares = yield* sql<{ total: number }>`
          SELECT count(*)::integer AS total FROM execution_tasks
          WHERE deployment_revision = 'trim-concurrency' AND state = 'spare'`;
        assert.strictEqual(remainingSpares[0]!.total, 2);
        // Now test that a slow provider stop during `trimSurplus` does not block `replenish` from
        // warming a staged revision using free budget slots.
        const extra2 = yield* provider.start({
          taskId: "trim-extra-2",
          deploymentRevision: "trim-concurrency",
          size: TaskProvider.full
        });
        const t = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO execution_tasks (task_id, deployment_revision, state, requested_at, started_at, ready_at)
          VALUES (${extra2.taskId}, 'trim-concurrency', 'spare', ${t + 20}, ${extra2.startedAt}, ${extra2.readyAt})`;
        yield* TestClock.adjust(40_000);
        const stopBlocked = yield* Deferred.make<void>();
        const releaseStop = yield* Deferred.make<void>();
        const slowStopProvider = TaskProvider.TaskProvider.of({
          ...provider,
          stop: (taskId) =>
            Deferred.succeed(stopBlocked, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStop)),
              Effect.andThen(provider.stop(taskId))
            )
        });
        const candidate = yield* Fleet.make({
          replicaId: "trim-concurrency-candidate",
          deploymentRevision: "trim-concurrency-new",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, slowStopProvider));
        assert.isTrue(yield* candidate.stageDeployment("trim-concurrency-new"));
        const pass = yield* candidate.housekeeping().pipe(Effect.forkChild);
        // Wait until the surplus spare stop is blocked AND verify `trim-concurrency-new` still
        // warmed its 2 spares using free budget slots without waiting for the stop to finish.
        yield* Deferred.await(stopBlocked);
        yield* phase(
          "staged revision warms while surplus trim stop is still blocked",
          Effect.gen(function* () {
            while (true) {
              const ready = yield* sql<{ total: number }>`
                SELECT count(*)::integer AS total FROM execution_tasks
                WHERE deployment_revision = 'trim-concurrency-new' AND state = 'spare'`;
              if (ready[0]!.total === 2) return;
              yield* TestClock.withLive(Effect.sleep(5));
            }
          })
        );
        yield* Deferred.succeed(releaseStop, undefined);
        assert.isTrue(yield* Fiber.join(pass));
        // Keep `left` referenced so setupMemory's resource stays clean.
        assert.isTrue(yield* left.promoteDeployment("trim-concurrency-new"));
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "expires waits at their deadline, sweeps them during housekeeping, and never records waits for prewarm",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, left, bundle } = yield* setupMemory("waiting-expiry");
        const store = yield* FleetStore.make;
        const fill = "cmp_fleet_waiting_expiry_fill";
        const cold = "cmp_fleet_waiting_expiry_cold";
        for (const company of [fill, cold])
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet expiry')`;
        yield* left.ensureBinding(companyId);
        yield* left.ensureBinding(fill);
        // Prewarm refuses on an empty pool without writing a wait row.
        const held = yield* Scope.make();
        assert.strictEqual(
          (yield* left.lifecycle.prewarm(cold).pipe(Scope.provide(held))).found,
          "full"
        );
        yield* Scope.close(held, Exit.void);
        const refused = yield* left.lifecycle
          .acquire(cold, bundle.patchId, "prewarm")
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, "busy");
        assert.deepStrictEqual(yield* sql`SELECT company_id FROM execution_pool_waits`, []);
        // Duplicate wait updates inside `claim` only move the deadline forward.
        const now = yield* Clock.currentTimeMillis;
        const clocks = FleetStore.clocksOf("page", now);
        assert.isUndefined(
          yield* store.claim(cold, "waiting-expiry-left", now, 0, clocks, undefined, now + 1_000)
        );
        assert.isUndefined(
          yield* store.claim(cold, "waiting-expiry-left", now, 0, clocks, undefined, now + 500)
        );
        assert.isUndefined(
          yield* store.claim(cold, "waiting-expiry-left", now, 0, clocks, undefined, now + 2_000)
        );
        assert.deepStrictEqual(yield* sql`SELECT company_id, until FROM execution_pool_waits`, [
          { company_id: cold, until: now + 2_000 }
        ]);
        assert.strictEqual(
          (yield* store.target(now + 1_999, 900_000, "waiting-expiry", false)).full.waiting,
          1
        );
        assert.strictEqual(
          (yield* store.target(now + 2_000, 900_000, "waiting-expiry", false)).full.waiting,
          0
        );
        yield* TestClock.adjust(2_000);
        assert.isTrue(yield* left.housekeeping());
        assert.deepStrictEqual(yield* sql`SELECT company_id FROM execution_pool_waits`, []);
        // Only the 2 baseline spares were launched beside the 2 bound tasks.
        assert.strictEqual(
          (yield* provider.list).filter((task) => task.state === "running").length,
          4
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "does not inflate a staged revision's spares before promotion or during initial bootstrap",
    () =>
      Effect.gen(function* () {
        // First-deployment bootstrap (`currentRevision === null`): waiting companies do not inflate
        // the unpromoted bootstrap revision beyond minimumSpares.
        yield* TestClock.setTime(1_000_000);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`TRUNCATE execution_deployments, execution_housekeeping, execution_breakers, execution_pool_waits CASCADE`;
        yield* sql`INSERT INTO execution_rollout(singleton) VALUES (true)`;
        const bootstrapProvider = MemoryTasks.make();
        const bootstrapHost = yield* Fleet.make({
          replicaId: "waiting-bootstrap-host",
          deploymentRevision: "waiting-bootstrap-v1",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, bootstrapProvider));
        const bootstrapReader = yield* Fleet.make({
          replicaId: "waiting-bootstrap-reader",
          deploymentRevision: "waiting-bootstrap-v1",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, bootstrapProvider));
        const bootstrapStore = yield* FleetStore.make;
        // Hold the lease on `bootstrapHost` so `bootstrapReader`'s waiters queue before the pass.
        assert.isDefined(
          yield* bootstrapStore.lease(
            "waiting-bootstrap-host",
            "waiting-bootstrap-v1",
            yield* Clock.currentTimeMillis,
            15_000
          )
        );
        const bootWaiters = [
          "cmp_fleet_waiting_boot_1",
          "cmp_fleet_waiting_boot_2",
          "cmp_fleet_waiting_boot_3"
        ] as const;
        for (const company of bootWaiters)
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet boot')
            ON CONFLICT (id) DO NOTHING`;
        const bootPending = yield* Effect.forEach(bootWaiters, (company) =>
          bootstrapReader.ensureBinding(company).pipe(Effect.forkChild)
        );
        yield* phase(
          "bootstrap waiters register demand",
          Effect.gen(function* () {
            while (true) {
              const rows = yield* sql<{ total: number }>`
                SELECT count(*)::integer AS total FROM execution_pool_waits`;
              if (rows[0]!.total === bootWaiters.length) return;
              yield* TestClock.withLive(Effect.sleep(5));
            }
          })
        );
        // First pass warms only minimumSpares (2) and promotes `waiting-bootstrap-v1`.
        assert.isTrue(yield* bootstrapHost.housekeeping());
        assert.strictEqual(
          (yield* bootstrapProvider.list).filter(
            (task) => task.deploymentRevision === "waiting-bootstrap-v1"
          ).length,
          2
        );
        yield* Effect.forEach(bootPending, Fiber.interrupt);

        // Live currentRevision with a staged candidate: staged gets floor (2), current gets floor + waiting.
        const { provider, companyId, left, right } = yield* setupMemory("waiting-staged-old");
        const fill = "cmp_fleet_waiting_staged_fill";
        const waiters = [
          "cmp_fleet_waiting_staged_1",
          "cmp_fleet_waiting_staged_2",
          "cmp_fleet_waiting_staged_3"
        ] as const;
        for (const company of [fill, ...waiters])
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet staged')`;
        yield* left.ensureBinding(companyId);
        yield* left.ensureBinding(fill);
        const candidate = yield* Fleet.make({
          replicaId: "waiting-staged-candidate",
          deploymentRevision: "waiting-staged-new",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.isTrue(yield* candidate.stageDeployment("waiting-staged-new"));
        // `right` is on the old revision, so its housekeeping requests yield while the candidate is staged.
        const pending = yield* Effect.forEach(waiters, (company) =>
          right.ensureBinding(company).pipe(Effect.forkChild)
        );
        yield* phase(
          "three waiting companies record demand before staged housekeeping",
          Effect.gen(function* () {
            while (true) {
              const rows = yield* sql<{ total: number }>`
                SELECT count(*)::integer AS total FROM execution_pool_waits`;
              if (rows[0]!.total === waiters.length) return;
              yield* TestClock.withLive(Effect.sleep(5));
            }
          })
        );
        assert.isTrue(yield* candidate.housekeeping());
        const tasks = yield* provider.list;
        // Staged revision gets only minimumSpares (2), while currentRevision gets minimumSpares (2) + waiting (3).
        assert.strictEqual(
          tasks.filter((task) => task.deploymentRevision === "waiting-staged-new").length,
          2
        );
        assert.strictEqual(
          tasks.filter((task) => task.deploymentRevision === "waiting-staged-old").length,
          7
        );
        const settle = <A, E>(fiber: Fiber.Fiber<A, E>) =>
          Effect.gen(function* () {
            while (fiber.pollUnsafe() === undefined) {
              yield* TestClock.adjust(50);
              yield* TestClock.withLive(Effect.sleep(5));
            }
            return yield* Fiber.join(fiber);
          });
        yield* phase(
          "waiting companies claim current-revision spares",
          Effect.forEach(pending, settle)
        );
        assert.deepStrictEqual(yield* sql`SELECT company_id FROM execution_pool_waits`, []);
      }).pipe(Effect.scoped),
    30_000
  );
});

it.layer(services)("host fleet controller over local tasks", (it) => {
  it.effect(
    "fences before stop, refuses adoption of stopping, and routes old admitted work while an open binds fresh",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle } = yield* setupLocal("fence");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
    "touches the current binding's task without claiming one, and none for a paused patch",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, bundle } = yield* setupMemory("touch");
        const version = {
          companyId,
          patchId: bundle.patchId,
          versionId: bundle.versionId,
          sha256: bundle.sha256
        };
        const sent: Array<{ readonly taskId: string; readonly bindingEpoch: number }> = [];
        const host = yield* Fleet.make({
          replicaId: "touch-host",
          deploymentRevision: "touch",
          automaticHousekeeping: false
        }).pipe(
          Effect.provideService(
            TaskProvider.TaskProvider,
            TaskProvider.TaskProvider.of({
              ...provider,
              touch: (taskId, request) => {
                sent.push({ taskId, bindingEpoch: request.bindingEpoch });
                return provider.touch(taskId, request);
              }
            })
          )
        );
        // A company without a binding stays without one.
        assert.strictEqual((yield* host.lifecycle.touch(version)).outcome, "unbound");
        assert.deepStrictEqual(
          yield* sql`SELECT task_id FROM execution_bindings WHERE company_id = ${companyId}`,
          []
        );
        const bound = yield* host.ensureBinding(companyId);
        assert.strictEqual((yield* host.lifecycle.touch(version)).outcome, "absent");
        // Adoption advances the epoch, and the next touch follows it.
        assert.isTrue(yield* host.adopt(bound, "touch-host"));
        const adopted = yield* host.ensureBinding(companyId);
        assert.isAbove(adopted.bindingEpoch, bound.bindingEpoch);
        assert.strictEqual((yield* host.lifecycle.touch(version)).outcome, "absent");
        assert.deepStrictEqual(sent, [
          { taskId: bound.taskId, bindingEpoch: bound.bindingEpoch },
          { taskId: bound.taskId, bindingEpoch: adopted.bindingEpoch }
        ]);
        // A paused patch's versions are left to idle out.
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE execution_breakers SET paused_until = ${now + 60_000}
          WHERE company_id = ${companyId} AND patch_id = ${version.patchId}`;
        assert.strictEqual((yield* host.lifecycle.touch(version)).outcome, "paused");
        assert.lengthOf(sent, 2);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "adopts only after global drain, advances the management epoch, and retains prior-epoch process metering",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle, sql } = yield* setupLocal("adopt");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        const loaded = yield* left.executor.bind(bundle, admission.binding);
        assert.isFalse(yield* right.adopt(admission.binding, "adopt-left"));
        yield* admission.release;
        assert.isTrue(yield* right.adopt(admission.binding, "adopt-left"));
        const adopted = yield* right.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        yield* provider.start({
          taskId: "unrecorded-task",
          deploymentRevision: "physical-budget",
          size: TaskProvider.full
        });
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
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        const freshAdmission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        const admitted = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
        // The company's first process on its local task says how long it took to start.
        assert.isTrue(original.firstOnTask);
        assert.isAbove(original.startMs!, 0);
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
        // The host adds the box its process ran on to the supervisor's report.
        assert.deepStrictEqual(delivered, { ...original, cpu: TaskProvider.full.cpu });
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
        const publish = yield* publishedPatch(companyId, bundle.patchId, "fleet-breaker");
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
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
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
          const admitted = yield* host.lifecycle.acquire(companyId, bundle.patchId, "page");
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
            .acquire(companyId, bundle.patchId, "page")
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
          (yield* right.lifecycle.acquire(companyId, bundle.patchId, "page").pipe(Effect.flip))
            .value,
          4
        );
        yield* left.removeLimitOverride(override);
        yield* publish(2);
        const fresh = yield* right.lifecycle.acquire(companyId, bundle.patchId, "page");
        yield* fresh.release;
        for (let index = 0; index < 3; index++)
          yield* kill(index % 2 === 0 ? left : right, `breaker-2-${index}`);
        const paused = (yield* sql<{
          paused_until: number;
        }>`SELECT paused_until FROM execution_breakers WHERE company_id = ${companyId} AND patch_id = ${bundle.patchId}`)[0]!
          .paused_until;
        yield* TestClock.setTime(paused - 1);
        assert.strictEqual(
          (yield* left.lifecycle.acquire(companyId, bundle.patchId, "page").pipe(Effect.flip)).code,
          "patch_paused"
        );
        yield* TestClock.adjust(1);
        const expired = yield* right.lifecycle.acquire(companyId, bundle.patchId, "page");
        yield* expired.release;
        const metering =
          yield* sql`SELECT count(*)::integer AS kills FROM execution_breaker_kills WHERE company_id = ${companyId}`;
        assert.strictEqual(metering[0]!.kills, 6);
      }).pipe(Effect.scoped),
    30_000
  );
});

// Box sizes: a case's floors and budget, every other limit at its default.
const sizing = (limits: Readonly<Record<string, number>>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_LIMITS_JSON: JSON.stringify(limits) }));
const addCompany = Effect.fn("FleetTest.addCompany")(function* (companyId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO companies(id, handle, name) VALUES (${companyId}, ${companyId}, 'Fleet test')`;
});
const addMember = Effect.fn("FleetTest.addMember")(function* (companyId: string, userId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${userId}, ${userId}, ${companyId}, ${`${userId}@fleet.test`}, 'Member', 'member')`;
});
const cpuOf = Effect.fn("FleetTest.cpuOf")(function* (taskId: string) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    cpu: number;
  }>`SELECT cpu FROM execution_tasks WHERE task_id = ${taskId}`)[0]!.cpu;
});
// Live tasks by state and CPU units: the pool and the budget as a case sees them.
const livePool = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ state: string; cpu: number; tasks: number }>`SELECT state, cpu,
    count(*)::integer AS tasks FROM execution_tasks WHERE state <> 'stopped'
    GROUP BY state, cpu ORDER BY state, cpu DESC`;
});
// The operator command's status, as plain values.
const smallBoxes = Effect.map(Fleet.smallBoxesStatus, ({ smallBoxes, small, unverified }) => ({
  smallBoxes,
  small,
  unverified
}));
const tasksOf = Effect.fn("FleetTest.tasksOf")(function* (state: string, cpu: number) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ task_id: string }>`SELECT task_id FROM execution_tasks
    WHERE state = ${state} AND cpu = ${cpu} ORDER BY requested_at`).map((row) => row.task_id);
});
// Captures the fleet's warnings and errors as plain lines.
const capturedLogs = () => {
  const lines: Array<{ readonly level: string; readonly message: string }> = [];
  const layer = Logger.layer([
    Logger.make((entry) => {
      const message = Array.isArray(entry.message) ? entry.message[0] : entry.message;
      if (typeof message === "string") lines.push({ level: entry.logLevel, message });
    })
  ]);
  const budget = () =>
    lines
      .filter((line) => line.message.startsWith("Execution fleet budget exhausted"))
      .map((line) => line.message);
  return { lines, layer, budget };
};

it.layer(services)("small boxes for one-member companies", (it) => {
  it.effect("runs as today with small boxes off, a starting row from before sizes included", () =>
    Effect.gen(function* () {
      const memory = MemoryTasks.make();
      const starts: Array<{ readonly taskId: string; readonly size: TaskProvider.Size }> = [];
      const recording = TaskProvider.TaskProvider.of({
        ...memory,
        start: (input) =>
          Effect.suspend(() => {
            starts.push(input);
            return memory.start(input);
          })
      });
      const { sql, companyId, left } = yield* setup("small-off", recording, recording, true);
      yield* addMember(companyId, "usr_small_off");
      const now = yield* Clock.currentTimeMillis;
      // A row an older release reserved and a wait it recorded small: both take today's defaults
      // or count as today's demand.
      yield* sql`INSERT INTO execution_tasks (task_id, deployment_revision, state, requested_at)
        VALUES ('legacy-starting', 'small-off', 'starting', ${now})`;
      yield* sql`INSERT INTO execution_pool_waits (company_id, until, cpu)
        VALUES ('cmp_small_off_waiting', ${now + 30_000}, ${TaskProvider.small.cpu})`;
      const store = yield* FleetStore.make;
      const measured = yield* store.target(now, 900_000, "small-off", false);
      assert.deepStrictEqual([measured.full.waiting, measured.small.waiting], [1, 0]);
      yield* left.housekeeping();
      assert.deepStrictEqual(
        starts.find((input) => input.taskId === "legacy-starting")?.size,
        TaskProvider.full
      );
      for (const input of starts) assert.deepStrictEqual(input.size, TaskProvider.full);
      // A one-member company claims a full box, and nothing small exists.
      const binding = yield* left.ensureBinding(companyId);
      assert.strictEqual(yield* cpuOf(binding.taskId), TaskProvider.full.cpu);
      assert.deepStrictEqual(
        yield* sql`SELECT task_id FROM execution_tasks WHERE cpu <> ${TaskProvider.full.cpu}`,
        []
      );
    }).pipe(Effect.scoped)
  );

  it.effect(
    "sizes each claim by the company's active members when it is made, and nothing else",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, left } = yield* setupMemory("small-members");
        yield* addMember(companyId, "usr_small_members_a");
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        const claimed = Effect.gen(function* () {
          const binding = yield* left.ensureBinding(companyId);
          yield* left.releaseCompany(companyId);
          return yield* cpuOf(binding.taskId);
        });
        assert.strictEqual(yield* claimed, TaskProvider.small.cpu);
        yield* addMember(companyId, "usr_small_members_b");
        assert.strictEqual(yield* claimed, TaskProvider.full.cpu);
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_small_members_b'`;
        assert.strictEqual(yield* claimed, TaskProvider.small.cpu);
        yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = 'usr_small_members_b'`;
        assert.strictEqual(yield* claimed, TaskProvider.full.cpu);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "makes a team wait rather than take a small spare, and counts what each waiter needs",
    () =>
      Effect.gen(function* () {
        const { sql, companyId, left } = yield* setupMemory("small-team");
        yield* addMember(companyId, "usr_small_team_a");
        yield* addMember(companyId, "usr_small_team_b");
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        for (const taskId of yield* tasksOf("spare", TaskProvider.full.cpu))
          yield* left.drainTask(taskId);
        const store = yield* FleetStore.make;
        const now = yield* Clock.currentTimeMillis;
        const miss = store.claim(
          companyId,
          "small-team-left",
          now,
          0,
          FleetStore.clocksOf("page", now),
          undefined,
          now + 30_000
        );
        assert.isUndefined(yield* miss);
        assert.strictEqual((yield* tasksOf("spare", TaskProvider.small.cpu)).length, 2);
        const waits = sql`SELECT cpu, until FROM execution_pool_waits WHERE company_id = ${companyId}`;
        assert.deepStrictEqual(yield* waits, [{ cpu: TaskProvider.full.cpu, until: now + 30_000 }]);
        let measured = yield* store.target(now, 900_000, "small-team", true);
        assert.deepStrictEqual([measured.full.waiting, measured.small.waiting], [1, 0]);
        // The same wait, with no small spare left, now needs a small box.
        for (const taskId of yield* tasksOf("spare", TaskProvider.small.cpu))
          yield* left.drainTask(taskId);
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_small_team_b'`;
        assert.isUndefined(yield* miss);
        assert.deepStrictEqual(yield* waits, [
          { cpu: TaskProvider.small.cpu, until: now + 30_000 }
        ]);
        measured = yield* store.target(now, 900_000, "small-team", true);
        assert.deepStrictEqual([measured.full.waiting, measured.small.waiting], [0, 1]);
        // With small boxes off, a wait recorded small is full demand.
        measured = yield* store.target(now, 900_000, "small-team", false);
        assert.deepStrictEqual([measured.full.waiting, measured.small.waiting], [1, 0]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "falls back to a ready full spare, keeps its tail, and counts the wake toward full spares",
    () =>
      Effect.gen(function* () {
        const captured = yield* recording;
        yield* Effect.gen(function* () {
          const { companyId, bundle, provider, left } = yield* setupMemory("small-fallback");
          const other = `${companyId}_other`;
          yield* addCompany(other);
          yield* addMember(companyId, "usr_small_fallback_a");
          yield* addMember(other, "usr_small_fallback_b");
          const store = yield* FleetStore.make;
          const wakes = Effect.gen(function* () {
            const measured = yield* store.target(
              yield* Clock.currentTimeMillis,
              900_000,
              "small-fallback",
              true
            );
            return [measured.full.wakes, measured.small.wakes];
          });
          // Switched on with no small spare warm yet: the open takes a full one at once.
          yield* Fleet.setSmallBoxes(true);
          const fallback = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
          yield* fallback.release;
          assert.strictEqual(yield* cpuOf(fallback.binding.taskId), TaskProvider.full.cpu);
          assert.deepStrictEqual(yield* wakes, [1, 0]);
          yield* left.housekeeping();
          const small = yield* left.lifecycle.acquire(other, bundle.patchId, "page");
          yield* small.release;
          assert.strictEqual(yield* cpuOf(small.binding.taskId), TaskProvider.small.cpu);
          assert.deepStrictEqual(yield* wakes, [1, 1]);
          const state = (taskId: string) =>
            Effect.map(
              provider.list,
              (tasks) => tasks.find((task) => task.taskId === taskId)?.state
            );
          // The tail follows the box: ten minutes on the small one, thirty on the full one.
          yield* left.housekeeping();
          yield* TestClock.adjust(10 * 60_000);
          yield* left.housekeeping();
          assert.strictEqual(yield* state(small.binding.taskId), "stopped");
          assert.strictEqual(yield* state(fallback.binding.taskId), "running");
          yield* TestClock.adjust(20 * 60_000);
          yield* left.housekeeping();
          assert.strictEqual(yield* state(fallback.binding.taskId), "stopped");
          const bindings = captured.records.flatMap((event) =>
            event.type === "binding" ? [[event.companyId, event.cpu]] : []
          );
          assert.sameDeepMembers(bindings, [
            [other, TaskProvider.small.cpu],
            [companyId, TaskProvider.full.cpu]
          ]);
        }).pipe(Effect.provideService(WideEvents.WideEvents, captured.events));
      }).pipe(Effect.scoped)
  );

  it.effect("counts the budget in vCPU and keeps and trims each size to its own target", () =>
    Effect.gen(function* () {
      const { companyId, left } = yield* setupMemory("small-budget");
      const solo = `${companyId}_solo`;
      yield* addCompany(solo);
      yield* addMember(solo, "usr_small_budget_solo");
      yield* addMember(companyId, "usr_small_budget_a");
      yield* addMember(companyId, "usr_small_budget_b");
      yield* Fleet.setSmallBoxes(true);
      yield* left.housekeeping();
      // Two small spares in the room of one full box: a full spare and two small ones are 2 vCPU.
      assert.deepStrictEqual(yield* livePool, [
        { state: "spare", cpu: 1024, tasks: 1 },
        { state: "spare", cpu: 512, tasks: 2 }
      ]);
      yield* left.ensureBinding(companyId);
      yield* left.ensureBinding(solo);
      const logs = capturedLogs();
      yield* left.housekeeping().pipe(Effect.provide(logs.layer));
      // The full deficit fits in the last vCPU; the small one then has no full box of room.
      assert.deepStrictEqual(yield* livePool, [
        { state: "bound", cpu: 1024, tasks: 1 },
        { state: "bound", cpu: 512, tasks: 1 },
        { state: "spare", cpu: 1024, tasks: 1 },
        { state: "spare", cpu: 512, tasks: 1 }
      ]);
      assert.deepStrictEqual(logs.budget(), [
        "Execution fleet budget exhausted revision=small-budget size=small budget=3 target=2 spares=1"
      ]);
      // Off, small spares are surplus and go after their grace; the small binding stays.
      yield* Fleet.setSmallBoxes(false);
      yield* TestClock.adjust(40_000);
      yield* left.housekeeping();
      assert.deepStrictEqual(yield* livePool, [
        { state: "bound", cpu: 1024, tasks: 1 },
        { state: "bound", cpu: 512, tasks: 1 },
        { state: "spare", cpu: 1024, tasks: 1 }
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        sizing({
          "execution.fleet.budget": 3,
          "execution.pool.spares": 1,
          "execution.pool.smallSpares": 2
        })
      )
    )
  );

  it.effect(
    "reserves no small spare while a full deficit is refused, and stops none for it, pass after pass",
    () =>
      Effect.gen(function* () {
        const { companyId, left } = yield* setupMemory("small-ceiling");
        const solo = `${companyId}_solo`;
        yield* addCompany(solo);
        yield* addMember(solo, "usr_small_ceiling_solo");
        yield* addMember(companyId, "usr_small_ceiling_a");
        yield* addMember(companyId, "usr_small_ceiling_b");
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        assert.deepStrictEqual(yield* livePool, [
          { state: "spare", cpu: 1024, tasks: 2 },
          { state: "spare", cpu: 512, tasks: 1 }
        ]);
        yield* left.ensureBinding(companyId);
        yield* left.ensureBinding(solo);
        const logs = capturedLogs();
        const sql = yield* SqlClient.SqlClient;
        const live = sql`SELECT task_id, state FROM execution_tasks WHERE state <> 'stopped'
          ORDER BY task_id`;
        const before = yield* live;
        for (let pass = 0; pass < 3; pass++) {
          yield* left.housekeeping().pipe(Effect.provide(logs.layer));
          assert.deepStrictEqual(yield* live, before);
          yield* TestClock.adjust(5_000);
        }
        // Each pass refused the full deficit and never tried the small one.
        assert.deepStrictEqual(logs.budget(), [
          "Execution fleet budget exhausted revision=small-ceiling size=full budget=3 target=2 spares=1",
          "Execution fleet budget exhausted revision=small-ceiling size=full budget=3 target=2 spares=1",
          "Execution fleet budget exhausted revision=small-ceiling size=full budget=3 target=2 spares=1"
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          sizing({
            "execution.fleet.budget": 3,
            "execution.pool.spares": 2,
            "execution.pool.smallSpares": 1
          })
        )
      )
  );

  it.effect(
    "warms only full spares for a staged revision and promotes it at the budget ceiling once room is freed",
    () =>
      Effect.gen(function* () {
        const { sql, provider, left } = yield* setupMemory("small-promote-a");
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        assert.deepStrictEqual(yield* livePool, [
          { state: "spare", cpu: 1024, tasks: 1 },
          { state: "spare", cpu: 512, tasks: 1 }
        ]);
        yield* sql`DELETE FROM execution_housekeeping`;
        const candidate = yield* Fleet.make({
          replicaId: "small-promote-b-host",
          deploymentRevision: "small-promote-b",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        assert.isTrue(yield* candidate.stageDeployment("small-promote-b"));
        const logs = capturedLogs();
        yield* candidate.housekeeping().pipe(Effect.provide(logs.layer));
        // The staged revision's full spare has no room; nothing small is tried meanwhile.
        assert.deepStrictEqual(logs.budget(), [
          "Execution fleet budget exhausted revision=small-promote-b size=full budget=2 target=1 spares=0"
        ]);
        assert.isFalse(yield* candidate.promoteDeployment("small-promote-b"));
        // Freeing budget for the promotion: the operator drains the current revision's small spare.
        for (const taskId of yield* tasksOf("spare", TaskProvider.small.cpu))
          yield* candidate.drainTask(taskId);
        yield* candidate.housekeeping();
        assert.isTrue(yield* candidate.promoteDeployment("small-promote-b"));
        assert.deepStrictEqual(
          yield* sql`SELECT cpu FROM execution_tasks WHERE deployment_revision = 'small-promote-b'`,
          [{ cpu: TaskProvider.full.cpu }]
        );
        // Promoted, it warms its own small spares once the earlier revision's spares drain.
        yield* candidate.housekeeping();
        yield* candidate.housekeeping();
        assert.deepStrictEqual(
          yield* sql`SELECT cpu FROM execution_tasks
            WHERE deployment_revision = 'small-promote-b' AND state = 'spare' ORDER BY cpu DESC`,
          [{ cpu: TaskProvider.full.cpu }, { cpu: TaskProvider.small.cpu }]
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          sizing({
            "execution.fleet.budget": 2,
            "execution.pool.spares": 1,
            "execution.pool.smallSpares": 2
          })
        )
      )
  );

  it.effect(
    "turns off with small spares and a small binding live, and its status clears once they are gone",
    () =>
      Effect.gen(function* () {
        const { companyId, bundle, left } = yield* setupMemory("small-switch");
        yield* addMember(companyId, "usr_small_switch");
        assert.deepStrictEqual(yield* smallBoxes, {
          smallBoxes: false,
          small: {},
          unverified: []
        });
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId, "page");
        yield* admission.release;
        yield* left.housekeeping();
        assert.deepStrictEqual(yield* smallBoxes, {
          smallBoxes: true,
          small: { bound: 1, spare: 2 },
          unverified: []
        });
        yield* Fleet.setSmallBoxes(false);
        yield* TestClock.adjust(40_000);
        yield* left.housekeeping();
        // The live binding keeps its box and its tail; only the spares went.
        assert.deepStrictEqual(yield* smallBoxes, {
          smallBoxes: false,
          small: { bound: 1 },
          unverified: []
        });
        yield* TestClock.adjust(10 * 60_000);
        yield* left.housekeeping();
        assert.deepStrictEqual(yield* smallBoxes, {
          smallBoxes: false,
          small: {},
          unverified: []
        });
        const next = yield* left.ensureBinding(companyId);
        assert.strictEqual(yield* cpuOf(next.taskId), TaskProvider.full.cpu);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "rechecks the switch at each write a pass planned while it was on: reserve, readiness and trim",
    () =>
      Effect.gen(function* () {
        const memory = MemoryTasks.make();
        const store = yield* FleetStore.make;
        let flipDuringLaunch = false;
        const flipping = TaskProvider.TaskProvider.of({
          ...memory,
          start: (input) =>
            memory
              .start(input)
              .pipe(
                Effect.tap(() =>
                  flipDuringLaunch && TaskProvider.isSmall(input.size)
                    ? store.setSmallBoxes(false).pipe(Effect.orDie)
                    : Effect.void
                )
              )
        });
        const { sql, left } = yield* setup("small-flip", flipping, flipping, true);
        const flipBefore = (pattern: RegExp) => {
          let flipped = false;
          const transform: Statement.Transformer = (statement) =>
            flipped || !pattern.test(statement.compile()[0])
              ? Effect.succeed(statement)
              : Effect.sync(() => {
                  flipped = true;
                }).pipe(
                  Effect.andThen(store.setSmallBoxes(false).pipe(Effect.orDie)),
                  Effect.as(statement)
                );
          return { transform, flipped: () => flipped };
        };
        // Planned on, refused at the reservation's lock.
        yield* Fleet.setSmallBoxes(true);
        const atReserve = flipBefore(/AND small_boxes AND current_revision/);
        yield* left
          .housekeeping()
          .pipe(Effect.provideService(Statement.CurrentTransformer, atReserve.transform));
        assert.isTrue(atReserve.flipped());
        assert.deepStrictEqual(yield* livePool, [{ state: "spare", cpu: 1024, tasks: 2 }]);
        // Reserved on, launched, and the switch went off before it was ready: drained.
        yield* Fleet.setSmallBoxes(true);
        flipDuringLaunch = true;
        yield* left.housekeeping();
        flipDuringLaunch = false;
        assert.deepStrictEqual(yield* livePool, [{ state: "spare", cpu: 1024, tasks: 2 }]);
        assert.deepStrictEqual(
          yield* sql`SELECT state, ready_at FROM execution_tasks WHERE cpu = ${TaskProvider.small.cpu}`,
          [
            { state: "stopped", ready_at: null },
            { state: "stopped", ready_at: null }
          ]
        );
        // Planned to keep one small spare of two, then kept none.
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO execution_tasks
          (task_id, deployment_revision, state, requested_at, started_at, ready_at, cpu)
          VALUES ('small-flip-extra', 'small-flip', 'spare', ${now + 1}, ${now}, ${now}, 512)`;
        yield* TestClock.adjust(40_000);
        const atTrim = flipBefore(/SELECT small_boxes AS "smallBoxes"/);
        yield* left
          .housekeeping()
          .pipe(Effect.provideService(Statement.CurrentTransformer, atTrim.transform));
        assert.isTrue(atTrim.flipped());
        assert.deepStrictEqual(yield* tasksOf("spare", TaskProvider.small.cpu), []);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "replaces a binding only with a spare its size allows, passing over one it cannot replace",
    () =>
      Effect.gen(function* () {
        const { sql, companyId: team, provider, left } = yield* setupMemory("small-replace-a");
        const solo = `${team}_solo`;
        const gone = `${team}_gone`;
        yield* addCompany(solo);
        yield* addCompany(gone);
        yield* addMember(team, "usr_small_replace_a");
        yield* addMember(team, "usr_small_replace_b");
        yield* addMember(solo, "usr_small_replace_solo");
        yield* addMember(gone, "usr_small_replace_gone");
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        // Bound oldest first: the team, then the one whose binding goes, then the one-member company.
        yield* left.ensureBinding(team);
        yield* left.ensureBinding(gone);
        yield* left.ensureBinding(solo);
        yield* sql`DELETE FROM execution_housekeeping`;
        // The next revision's host registers it; it is promoted with only a small spare ready.
        yield* Fleet.make({
          replicaId: "small-replace-b-host",
          deploymentRevision: "small-replace-b",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        const now = yield* Clock.currentTimeMillis;
        yield* provider.start({
          taskId: "small-replace-b-small",
          deploymentRevision: "small-replace-b",
          size: TaskProvider.small
        });
        yield* sql`INSERT INTO execution_tasks
          (task_id, deployment_revision, state, requested_at, started_at, ready_at, cpu)
          VALUES ('small-replace-b-small', 'small-replace-b', 'spare', ${now}, ${now}, ${now}, 512)`;
        yield* sql`UPDATE execution_rollout SET current_revision = 'small-replace-b',
          staged_revision = NULL`;
        // The binding between them is released after the scan and before its lock.
        let released = false;
        const store = yield* FleetStore.make;
        const releaseBeforeLock: Statement.Transformer = (statement) =>
          released || !statement.compile()[1].includes(`execution/claim/${gone}`)
            ? Effect.succeed(statement)
            : Effect.sync(() => {
                released = true;
              }).pipe(
                Effect.andThen(
                  sql`UPDATE execution_bindings SET state = 'stopping', release_cause = 'idle'
                    WHERE company_id = ${gone} AND state = 'active'`.pipe(Effect.orDie)
                ),
                Effect.as(statement)
              );
        const replaced = yield* store
          .replaceDeploymentBinding("small-replace-b-host", now)
          .pipe(Effect.provideService(Statement.CurrentTransformer, releaseBeforeLock));
        assert.isTrue(released);
        assert.strictEqual(replaced?.previous.companyId, solo);
        assert.strictEqual(replaced?.replacement.taskId, "small-replace-b-small");
        // The team was passed over with its binding intact, and nothing else was fenced.
        assert.deepStrictEqual(
          yield* sql`SELECT company_id, state, release_cause FROM execution_bindings
            WHERE company_id IN (${team}, ${gone}) ORDER BY binding_id`,
          [
            { company_id: team, state: "active", release_cause: null },
            { company_id: gone, state: "stopping", release_cause: "idle" }
          ]
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "admits a task at the size it runs at, within the budget, and retries a launch at the size it asked for",
    () =>
      Effect.gen(function* () {
        const memory = MemoryTasks.make();
        const starts: Array<{ readonly taskId: string; readonly size: TaskProvider.Size }> = [];
        let ambiguous = true;
        // Fargate ignoring the override: every task runs at the definition's full size.
        const ignoring = TaskProvider.TaskProvider.of({
          ...memory,
          start: (input) =>
            Effect.suspend(() => {
              starts.push(input);
              if (TaskProvider.isSmall(input.size) && ambiguous) {
                ambiguous = false;
                return Effect.fail(
                  new TaskProvider.TaskProviderError({
                    operation: "start",
                    taskId: input.taskId,
                    reason: "provider"
                  })
                );
              }
              return memory.start({ ...input, size: TaskProvider.full });
            })
        });
        const { left } = yield* setup("small-verify", ignoring, ignoring, true);
        yield* Fleet.setSmallBoxes(true);
        const logs = capturedLogs();
        const charged = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{ cpu: number }>`SELECT COALESCE(sum(CASE WHEN ready_at IS NULL
            THEN 1024 ELSE cpu END), 0)::integer AS cpu FROM execution_tasks
            WHERE state <> 'stopped'`)[0]!.cpu;
        });
        yield* left.housekeeping().pipe(Effect.provide(logs.layer));
        // Its launch lost, the small row stays starting and is charged a full box.
        assert.deepStrictEqual(yield* livePool, [
          { state: "spare", cpu: 1024, tasks: 1 },
          { state: "starting", cpu: 512, tasks: 1 }
        ]);
        assert.strictEqual(yield* charged, 2048);
        yield* left.housekeeping().pipe(Effect.provide(logs.layer));
        const small = starts.filter((input) => TaskProvider.isSmall(input.size));
        assert.strictEqual(small.length, 2);
        assert.strictEqual(small[0]!.taskId, small[1]!.taskId);
        // Ready at full size, it is a full spare now, still within the budget.
        assert.deepStrictEqual(yield* livePool, [{ state: "spare", cpu: 1024, tasks: 2 }]);
        assert.strictEqual(yield* charged, 2048);
        assert.isTrue(
          logs.lines.some(
            (line) =>
              line.level === "Error" &&
              line.message === "Execution task started at a size other than it asked for"
          )
        );
        // Surplus at full size, it is trimmed like any other. The next small launch may come up
        // full again in the same pass, and stays within the budget too.
        yield* TestClock.adjust(40_000);
        yield* left.housekeeping();
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM execution_tasks WHERE task_id = ${small[0]!.taskId}`,
          [{ state: "stopped" }]
        );
        assert.isAtMost(yield* charged, 2048);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          sizing({
            "execution.fleet.budget": 2,
            "execution.pool.spares": 1,
            "execution.pool.smallSpares": 1
          })
        )
      )
  );

  it.effect(
    "prewarms only a spare of the company's size, with a full box of room to replace it",
    () =>
      Effect.gen(function* () {
        const { companyId, left } = yield* setupMemory("small-prewarm");
        yield* addMember(companyId, "usr_small_prewarm");
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        yield* left.housekeeping();
        // Two small spares and a full one: 2 vCPU of 2.5, half a vCPU of room.
        assert.deepStrictEqual(yield* livePool, [
          { state: "spare", cpu: 1024, tasks: 1 },
          { state: "spare", cpu: 512, tasks: 2 }
        ]);
        const held = yield* Scope.make();
        assert.strictEqual(
          (yield* left.lifecycle.prewarm(companyId).pipe(Scope.provide(held))).found,
          "full"
        );
        yield* Scope.close(held, Exit.void);
        for (const taskId of yield* tasksOf("spare", TaskProvider.full.cpu))
          yield* left.drainTask(taskId);
        const again = yield* Scope.make();
        assert.strictEqual(
          (yield* left.lifecycle.prewarm(companyId).pipe(Scope.provide(again))).found,
          "spare"
        );
        const bound = yield* left.ensureBinding(companyId);
        assert.strictEqual(yield* cpuOf(bound.taskId), TaskProvider.small.cpu);
        yield* Scope.close(again, Exit.void);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          sizing({
            "execution.fleet.budget": 2.5,
            "execution.pool.spares": 1,
            "execution.pool.smallSpares": 2
          })
        )
      )
  );

  it.effect(
    "drains small rows still starting once off, completing each only on evidence it stopped",
    () =>
      Effect.gen(function* () {
        const memory = MemoryTasks.make();
        const stops: string[] = [];
        const order: string[] = [];
        // The first small launch is refused outright, the next two go unanswered.
        const failing = TaskProvider.TaskProvider.of({
          ...memory,
          start: (input) =>
            Effect.suspend(() => {
              if (!TaskProvider.isSmall(input.size)) return memory.start(input);
              if (!order.includes(input.taskId)) order.push(input.taskId);
              return Effect.fail(
                new TaskProvider.TaskProviderError({
                  operation: "start",
                  taskId: input.taskId,
                  reason: order.indexOf(input.taskId) === 0 ? "launch_refused" : "provider"
                })
              );
            }),
          stop: (taskId) =>
            Effect.suspend(() => {
              stops.push(taskId);
              return memory.stop(taskId);
            })
        });
        const { sql, left } = yield* setup("small-recover", failing, failing, true);
        yield* Fleet.setSmallBoxes(true);
        yield* left.housekeeping();
        yield* left.housekeeping();
        const [refused, late, lost] = order;
        const rows = sql`SELECT task_id, state, launch_refused_at IS NOT NULL AS refused
          FROM execution_tasks WHERE cpu = ${TaskProvider.small.cpu} ORDER BY task_id`;
        // On, a refused launch is retried on the same row and stays charged.
        assert.sameDeepMembers(
          [...(yield* rows)],
          [
            { task_id: refused, state: "starting", refused: true },
            { task_id: late, state: "starting", refused: false },
            { task_id: lost, state: "starting", refused: false }
          ]
        );
        yield* Fleet.setSmallBoxes(false);
        yield* left.housekeeping();
        assert.sameDeepMembers(
          [...(yield* rows)],
          [
            { task_id: refused, state: "stopped", refused: true },
            { task_id: late, state: "stopping", refused: false },
            { task_id: lost, state: "stopping", refused: false }
          ]
        );
        assert.notInclude(stops, refused);
        // One launch turns up after all and is stopped; the other never does and stays charged.
        yield* memory.start({
          taskId: late!,
          deploymentRevision: "small-recover",
          size: TaskProvider.small
        });
        yield* left.housekeeping();
        const status = yield* Fleet.smallBoxesStatus;
        assert.deepStrictEqual(status.unverified, [
          { taskId: lost!, state: "stopping", cpu: TaskProvider.small.cpu, launchRefused: false }
        ]);
        assert.strictEqual(
          (yield* sql`SELECT state FROM execution_tasks WHERE task_id = ${late!}`)[0]!.state,
          "stopped"
        );
        // Unverified, it is charged a full box: with it at half, 2.5 vCPU would have room.
        yield* sql`DELETE FROM execution_housekeeping`;
        const store = yield* FleetStore.make;
        const now = yield* Clock.currentTimeMillis;
        const lease = (yield* store.lease("small-recover-probe", "small-recover", now, 15_000))!;
        assert.deepStrictEqual(
          yield* store.reserve(
            "small-recover-probe",
            "small-recover",
            TaskProvider.full,
            "small-recover-probe",
            lease.leaseEpoch,
            now,
            2.5
          ),
          { outcome: "budget", spares: 1 }
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(sizing({ "execution.pool.spares": 1, "execution.pool.smallSpares": 3 }))
      )
  );
});
