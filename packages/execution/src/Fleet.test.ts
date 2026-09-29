// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- actual child supervisors use wall-clock deadlines; TestClock controls the host's idle and breaker windows.
import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as GuestProtocol from "@patchy/api/guest";
import { OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Fleet from "./fleet.js";
import * as LocalTaskProvider from "./localTaskProvider.js";
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
const setup = Effect.fn("FleetTest.setup")(function* (name: string) {
  yield* TestClock.setTime(Date.now());
  const sql = yield* SqlClient.SqlClient;
  const companyId = `cmp_fleet_${name}`;
  yield* sql`INSERT INTO companies(id, handle, name) VALUES (${companyId}, ${`fleet-${name}`}, 'Fleet test')`;
  const provider = yield* LocalTaskProvider.make({ callbackUrls: [callbackUrl] });
  const left = yield* Fleet.make({
    replicaId: `${name}-left`,
    deploymentRevision: name,
    automaticHousekeeping: false
  }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
  const right = yield* Fleet.make({
    replicaId: `${name}-right`,
    deploymentRevision: name,
    automaticHousekeeping: false
  }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
  const bundle: GuestProtocol.Bundle = {
    companyId,
    patchId: `pat_${name}`,
    versionId: `ver_${name}`,
    sha256,
    bundle: source
  };
  return { sql, companyId, provider, left, right, bundle };
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
        yield* TestClock.adjust(15_000);
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
        const { provider, left, right, sql } = yield* setup("budget");
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
        yield* Fleet.make({
          replicaId: "bind-rollout-new",
          deploymentRevision: "bind-rollout-new",
          automaticHousekeeping: false
        }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
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
    "fences superseded admissions before housekeeping while predecessor calls drain and reports the emitting build",
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
        // No housekeeping pass has fenced the predecessor. Admission must do it.
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
        assert.strictEqual((yield* collector.housekeeping().pipe(Effect.result))._tag, "Failure");
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
        const { companyId, left, right, bundle, sql } = yield* setup("breaker");
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
            yield* host.executor
              .invoke(
                request(
                  loaded.binding,
                  loaded.processGeneration!,
                  `kill-${round}-${index}`,
                  "demo.spin"
                ),
                admission.binding
              )
              .pipe(Effect.result);
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
});
