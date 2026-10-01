// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- actual child supervisors use wall-clock deadlines; TestClock controls the host's idle and breaker windows.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as GuestProtocol from "@patchy/api/guest";
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
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import * as Fleet from "./fleet.js";
import * as LocalTaskProvider from "./localTaskProvider.js";
import * as LocalTaskStore from "./localTaskStore.js";
import * as TaskProvider from "./TaskProvider.js";

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
const setup = Effect.fn("FleetTest.setup")(function* (name: string, warm = true) {
  yield* TestClock.setTime(Date.now());
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE execution_deployments, execution_housekeeping, execution_breakers CASCADE`;
  yield* sql`INSERT INTO execution_rollout(singleton) VALUES (true)`;
  const companyId = `cmp_fleet_${name}`;
  yield* sql`INSERT INTO companies(id, handle, name) VALUES (${companyId}, ${`fleet-${name}`}, 'Fleet test')`;
  const resource = yield* LocalTaskProvider.resource({ callbackUrls: [callbackUrl] });
  const provider = yield* LocalTaskProvider.make(resource);
  const otherProvider = yield* LocalTaskProvider.make(resource);
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
  return { sql, companyId, provider, otherProvider, resource, left, right, bundle };
});
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
const renewalClock = Effect.gen(function* () {
  const clock = yield* TestClock.testClockWith(Effect.succeed);
  const armed = yield* Queue.unbounded<void>();
  const renewed = new WeakSet<Fiber.Fiber<unknown, unknown>>();
  const transform: Statement.Transformer = (statement, _sql, fiber) =>
    Effect.sync(() => {
      if (/^\s*UPDATE execution_housekeeping\b/.test(statement.compile()[0])) renewed.add(fiber);
      else renewed.delete(fiber);
      return statement;
    });
  const observed: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.withFiber((fiber) => {
        if (Duration.toMillis(duration) !== 5_000 || !renewed.has(fiber))
          return clock.sleep(duration);
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
    "claims one company once and retries an ambiguous acknowledgement on its exact task and epoch",
    () =>
      Effect.gen(function* () {
        const { sql, provider, companyId, right } = yield* setup("claim");
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
    "reconciles a real task stopped between the durable claim and its first supervisor bind",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, right, sql } = yield* setup("prebind-stop");
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
        const claimedTask =
          (yield* sql`SELECT task_id FROM execution_bindings WHERE company_id = ${companyId}`)[0]!
            .task_id;
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
    "fences before stop, refuses adoption of stopping, and routes old admitted work while an open binds fresh",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle } = yield* setup("fence");
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
        const { companyId, provider, left, right, bundle, sql } = yield* setup("adopt");
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
    "abandons a housekeeping pass that lost its lease while provider observation was delayed",
    () =>
      Effect.gen(function* () {
        const { provider, right, sql } = yield* setup("lease-loss");
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

  it.effect(
    "counts documents on another host and full invocation settlement before the thirty-minute idle window",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle } = yield* setup("idle");
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
        const { provider, resource, companyId, bundle, left, right, sql } = yield* setup("budget");
        const admission = yield* left.lifecycle.acquire(companyId, bundle.patchId);
        const loaded = yield* left.executor.bind(bundle, admission.binding);
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
        assert.strictEqual(yield* liveChildren(resource.directory), 2);
        yield* TestClock.adjust(15_000);
        assert.isTrue(yield* right.housekeeping());
        assert.isFalse(yield* left.housekeeping());
        assert.strictEqual(
          (yield* right.ensureBinding(companyId)).taskId,
          admission.binding.taskId
        );
        const reply = yield* right.executor.invoke(
          request(loaded.binding, loaded.processGeneration!, "after-real-lease-transfer"),
          admission.binding
        );
        assert.strictEqual(reply.outcome, "returned");
        assert.strictEqual(yield* liveChildren(resource.directory), 2);
        yield* admission.release;
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PATCHY_LIMITS_JSON: '{"execution.fleet.budget":2,"execution.pool.spares":4}'
            })
          )
        )
      ),
    30_000
  );

  it.effect(
    "does not return a predecessor whose bind acknowledgement arrives after deployment replacement",
    () =>
      Effect.gen(function* () {
        const { provider, companyId } = yield* setup("bind-rollout");
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
    "promotes warm spares explicitly and replaces admissions while predecessor calls drain",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle } = yield* setup("rollout-old");
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
    "reconciles stop time and emits the original process event once when report acknowledgement is retried",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, bundle, sql } = yield* setup("meter");
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
        const reports =
          yield* sql`SELECT calls_served, cpu_seconds, peak_rss_bytes FROM execution_processes
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
    "pauses across versions and hosts after three real watchdog kills, clears on publish, and expires after ten minutes",
    () =>
      Effect.gen(function* () {
        const { companyId, provider, left, right, bundle, sql } = yield* setup("breaker");
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
        const killThree = Effect.fn("killThreeVersions")(function* (round: number) {
          for (let index = 0; index < 3; index++) {
            const host = index % 2 === 0 ? left : right;
            const admission = yield* host.lifecycle.acquire(companyId, bundle.patchId);
            const version = { ...bundle, versionId: `breaker-${round}-${index}` };
            const loaded = yield* host.executor.bind(version, admission.binding);
            const failure = yield* host.executor
              .invoke(
                request(
                  loaded.binding,
                  loaded.processGeneration!,
                  `kill-${round}-${index}`,
                  "demo.spin"
                ),
                admission.binding
              )
              .pipe(Effect.flip);
            assert.strictEqual(failure.reason, "process_killed");
            // Invocation failure is fail-fast; final metering follows the actual child reap.
            yield* TestClock.testClockWith((clock) =>
              clock.withLive(
                Effect.gen(function* () {
                  while (true) {
                    const stats = yield* provider.stats(admission.binding.taskId, {
                      bindingEpoch: admission.binding.bindingEpoch
                    });
                    const report = stats.reports.find(
                      (report) => report.processGeneration === loaded.processGeneration
                    );
                    if (report) {
                      assert.oneOf(report.cause, ["deadline", "stall", "memory"]);
                      return;
                    }
                    yield* Effect.sleep(10);
                  }
                }).pipe(Effect.timeout("5 seconds"))
              )
            );
            yield* admission.release;
            yield* left.housekeeping();
          }
        });
        yield* killThree(1);
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
        yield* killThree(2);
        const paused =
          (yield* sql`SELECT paused_until FROM execution_breakers WHERE company_id = ${companyId} AND patch_id = ${bundle.patchId}`)[0]!
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
    60_000
  );

  it.effect(
    "renews the lease during concurrent cold starts longer than the lease and serves within the pool deadline",
    () =>
      Effect.gen(function* () {
        const { provider, resource, companyId, right, sql } = yield* setup("slow-cold", false);
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
            assert.isAtLeast(binding.spareWaitMs, 25_000);
            assert.isBelow(binding.spareWaitMs, 40_000);
            assert.strictEqual((yield* right.ensureBinding(companyId)).taskId, binding.taskId);
            const tasks = yield* provider.list;
            assert.strictEqual(tasks.filter((task) => task.state === "running").length, 2);
            assert.strictEqual(ids.size, 2);
            assert.strictEqual(yield* liveChildren(resource.directory), 2);
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
    "isolates wedged stats and failed binds, stops and starts while healthy companies claim replenished spares",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, left, sql } = yield* setup("isolated");
        const clock = yield* renewalClock;
        yield* clock.provide(
          Effect.gen(function* () {
            const secondCompany = "cmp_fleet_isolated_second";
            const thirdCompany = "cmp_fleet_isolated_third";
            for (const company of [secondCompany, thirdCompany])
              yield* sql`INSERT INTO companies(id, handle, name) VALUES (${company}, ${company}, 'Fleet isolation')`;
            const wedged = yield* left.ensureBinding(companyId);
            const failing = yield* left.ensureBinding(secondCompany);
            yield* sql`UPDATE execution_bindings SET state = 'claiming' WHERE task_id = ${failing.taskId}`;
            yield* provider.start({ taskId: "isolated-stubborn", deploymentRevision: "isolated" });
            const observed = yield* Deferred.make<void>();
            const replenished = yield* Deferred.make<void>();
            let launches = 0;
            const unhealthy = TaskProvider.TaskProvider.of({
              ...provider,
              stats: (taskId, input) =>
                taskId === wedged.taskId
                  ? Deferred.succeed(observed, undefined).pipe(Effect.andThen(Effect.never))
                  : provider.stats(taskId, input),
              bind: (taskId, input) =>
                taskId === failing.taskId
                  ? Effect.fail(
                      new TaskProvider.TaskProviderError({
                        operation: "bind",
                        taskId,
                        reason: "transport"
                      })
                    )
                  : provider.bind(taskId, input),
              stop: (taskId) =>
                taskId === "isolated-stubborn"
                  ? Effect.fail(
                      new TaskProvider.TaskProviderError({
                        operation: "stop",
                        taskId,
                        reason: "transport"
                      })
                    )
                  : provider.stop(taskId),
              start: Effect.fn("failOneLaunch")(function* (input) {
                const number = ++launches;
                if (number === 1)
                  return yield* new TaskProvider.TaskProviderError({
                    operation: "start",
                    taskId: input.taskId,
                    reason: "provider"
                  });
                const task = yield* provider.start(input);
                if (number >= 3) yield* Deferred.succeed(replenished, undefined);
                return task;
              })
            });
            const owner = yield* Fleet.make({
              replicaId: "isolated-owner",
              deploymentRevision: "isolated",
              automaticHousekeeping: false
            }).pipe(Effect.provideService(TaskProvider.TaskProvider, unhealthy));
            let completed = false;
            const pass = yield* owner.housekeeping().pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  completed = true;
                })
              ),
              Effect.forkChild
            );
            yield* Deferred.await(observed);
            const healthy = yield* owner.ensureBinding(thirdCompany);
            assert.notStrictEqual(healthy.taskId, wedged.taskId);
            assert.notStrictEqual(healthy.taskId, failing.taskId);
            assert.strictEqual(healthy.state, "active");
            assert.isFalse(completed);
            yield* clock.advance(5_000);
            yield* Deferred.await(replenished);
            yield* Effect.gen(function* () {
              while (true) {
                const rows = yield* sql`SELECT task_id FROM execution_tasks WHERE state = 'spare'`;
                if (rows.length > 0) return;
              }
            });
            yield* clock.advance(30_000);
            yield* TestClock.adjust(5_000);
            assert.isTrue(yield* Fiber.join(pass));
            const rows =
              yield* sql`SELECT state FROM execution_bindings WHERE task_id = ${failing.taskId}`;
            assert.strictEqual(rows[0]!.state, "claiming");
            const spares =
              yield* sql`SELECT count(*)::integer AS total FROM execution_tasks WHERE state = 'spare'`;
            assert.isAtLeast(spares[0]!.total, 1);
            assert.strictEqual((yield* owner.ensureBinding(thirdCompany)).taskId, healthy.taskId);
            assert.strictEqual(
              (yield* provider.list).find((task) => task.taskId === "isolated-stubborn")!.state,
              "running"
            );
          })
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "keeps a waiter until its full pool deadline despite failed provider work",
    () =>
      Effect.gen(function* () {
        const { provider, companyId, left } = yield* setup("wait-failures", false);
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
        const { provider, companyId, left, sql } = yield* setup("staged-old");
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
        for (let index = 0; index < companies.length; index++)
          assert.strictEqual(
            (yield* candidate.ensureBinding(companies[index]!)).taskId,
            original[index]!.taskId
          );
        assert.isFalse(yield* candidate.promoteDeployment("staged-new"));
        assert.isTrue(yield* candidate.stageDeployment("staged-new"));
        assert.isFalse(yield* candidate.promoteDeployment("staged-new"));
        yield* left.housekeeping();
        assert.isTrue(yield* candidate.promoteDeployment("staged-new"));
        // Promotion changes spare admission, not every company's existing binding at once.
        for (let index = 0; index < companies.length; index++)
          assert.strictEqual(
            (yield* candidate.ensureBinding(companies[index]!)).taskId,
            original[index]!.taskId
          );
        yield* left.housekeeping();
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
        for (let pass = 0; pass < companies.length; pass++) yield* left.housekeeping();
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
