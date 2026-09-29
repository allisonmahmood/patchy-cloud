import { randomUUID } from "node:crypto";
import * as WideEvents from "@patchy/analytics/wide-events";
import type { GuestProtocol } from "@patchy/api";
import * as DeploymentConfig from "@patchy/limits/deployment-config";
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import * as Executor from "@patchy/runtime/executor";
import * as ExecutionLifecycle from "@patchy/runtime/execution-lifecycle";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as FleetActivity from "./fleetActivity.js";
import * as FleetStore from "./fleetStore.js";
import * as TaskProvider from "./TaskProvider.js";

export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
  operation: Schema.Literals([
    "bind",
    "release",
    "drain",
    "housekeeping",
    "stage",
    "promote",
    "publish",
    "history"
  ]),
  cause: Schema.Defect()
}) {
  override get message() {
    return `Execution fleet ${this.operation} failed.`;
  }
}
class LeaseLost extends Schema.TaggedError<LeaseLost>()("FleetLeaseLost", {
  leaseEpoch: Schema.Number
}) {}
const isLeaseLost = Schema.is(LeaseLost);
const isFleetError = Schema.is(FleetError);
const housekeepingGuard = Context.Reference<Effect.Effect<void, SqlError | LeaseLost>>(
  "@patchy/execution/FleetHousekeepingGuard",
  { defaultValue: () => Effect.void }
);
const checkHousekeeping = Effect.flatMap(housekeepingGuard, (guard) => guard);
export interface Options {
  readonly replicaId: string;
  readonly deploymentRevision: string;
  readonly automaticHousekeeping?: boolean;
  readonly dev?: boolean;
}
const isExecutionReason = Schema.is(Executor.ExecutionError.fields.reason);
const isLifecycleError = Schema.is(ExecutionLifecycle.LifecycleError);
const executionError = (cause: TaskProvider.TaskProviderError) =>
  new Executor.ExecutionError({
    operation: cause.operation === "invoke" ? "invoke" : "bind",
    reason: isExecutionReason(cause.reason) ? cause.reason : "transport",
    ...(cause.limit === undefined ? {} : { limit: cause.limit }),
    ...(cause.limits === undefined ? {} : { limits: cause.limits }),
    cause
  });

/** Host code, not a service deployment. One instance is scoped to one host replica. */
export const make = Effect.fn("Fleet.make")(function* (options: Options) {
  const provider = yield* TaskProvider.TaskProvider;
  const limits = yield* OperatingLimits.OperatingLimits;
  const config = yield* DeploymentConfig.load;
  const maximumCallMs =
    (yield* ContractLimits.get("tier2.action.deadline")) +
    (yield* ContractLimits.get("tier2.settlement.cleanup"));
  const events = yield* WideEvents.WideEvents;
  const store = yield* FleetStore.make;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const housekeepingLock = yield* Semaphore.make(1);
  const activity = yield* FleetActivity.make({
    checkInterval: config.get("execution.housekeeping.interval")
  });
  yield* store.registerDeployment(options.deploymentRevision);
  yield* Effect.addFinalizer(() =>
    sql`DELETE FROM execution_housekeeping WHERE owner_id = ${options.replicaId}`.pipe(Effect.orDie)
  );
  let changed = yield* Deferred.make<void>();
  const notify = Effect.gen(function* () {
    const previous = changed;
    changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });
  const supervisorLimits = Effect.fn("Fleet.supervisorLimits")(function* (companyId: string) {
    const effective = yield* limits.getMany({
      companyId,
      limits: {
        "execution.probe.interval": "execution.probe.interval",
        "execution.process.rss": "execution.process.rss",
        "execution.residency.processes": "execution.residency.processes",
        "execution.residency.bytes": "execution.residency.bytes",
        "execution.process.idle": "execution.process.idle"
      }
    });
    return {
      operatingLimits: Object.fromEntries(
        Object.entries(effective).map(([id, limit]) => [id, limit.value])
      ),
      configRevision: effective["execution.process.rss"].configRevision
    };
  });
  const lifecycleFailure = (cause: unknown) =>
    new ExecutionLifecycle.LifecycleError({
      code: "source_unavailable",
      status: 503,
      retryAfterSeconds: 1,
      cause
    });
  const busy = (wait: number) =>
    new ExecutionLifecycle.LifecycleError({
      code: "busy",
      status: 503,
      retryAfterSeconds: 1,
      limitId: "execution.pool.wait",
      scope: "company",
      value: wait
    });
  const collect = Effect.fn("Fleet.collectReports")(function* (
    binding: FleetStore.Binding,
    stopped = false
  ) {
    yield* checkHousekeeping;
    const stats = yield* provider
      .stats(binding.taskId, { bindingEpoch: binding.bindingEpoch })
      .pipe(
        Effect.catchTags({
          TaskProviderError: (cause) => {
            if (!stopped || cause.reason !== "stale_epoch") return Effect.fail(cause);
            // A stop can win after the durable claim but before the supervisor's
            // first bind. Epoch zero is accepted only as a stopped, unbound task.
            return provider
              .stats(binding.taskId, { bindingEpoch: 0 })
              .pipe(
                Effect.flatMap((final) =>
                  final.stopped &&
                  final.companyId === null &&
                  final.bindingEpoch === 0 &&
                  final.reports.length === 0
                    ? Effect.succeed(final)
                    : Effect.fail(cause)
                )
              );
          }
        })
      );
    const settings = yield* limits.getMany({
      companyId: binding.companyId,
      limits: {
        kills: "execution.breaker.kills",
        window: "execution.breaker.window",
        pause: "execution.breaker.pause"
      }
    });
    const now = yield* Clock.currentTimeMillis;
    let peakProcesses = stats.processes.length;
    for (const report of stats.reports) {
      if (
        report.bindingEpoch > binding.bindingEpoch ||
        report.binding.companyId !== binding.companyId
      )
        return yield* new TaskProvider.TaskProviderError({
          operation: "stats",
          taskId: binding.taskId,
          reason: "protocol"
        });
      yield* checkHousekeeping;
      const inserted = yield* store.report(
        binding,
        report,
        {
          kills: settings.kills.value,
          window: settings.window.value,
          pause: settings.pause.value
        },
        now
      );
      if (inserted) yield* events.emit(report.event);
      peakProcesses = Math.max(peakProcesses, 1);
      for (const limit of report.event.limits ?? []) {
        if (limit.limitId === "execution.residency.processes")
          peakProcesses = Math.max(peakProcesses, limit.peak);
      }
    }
    yield* checkHousekeeping;
    yield* store.peak(binding.bindingId, peakProcesses);
    // Never acknowledge a report until both process metering and the breaker commit.
    if (stats.reports.length > 0)
      yield* provider.stats(binding.taskId, {
        bindingEpoch: binding.bindingEpoch,
        acknowledgeReports: stats.reports.map((report) => report.reportId)
      });
  });
  const emitBindings = Effect.gen(function* () {
    for (const row of yield* store.pendingEvents(undefined)) {
      yield* checkHousekeeping;
      yield* events.withEvent(
        {
          type: "binding",
          eventId: `binding:${row.bindingId}`,
          companyId: row.companyId,
          taskId: row.taskId,
          replica: options.replicaId,
          deploymentRevision: options.deploymentRevision,
          startedAt: row.boundAt,
          endedAt: row.releasedAt!,
          spareWaitMs: row.spareWaitMs,
          peakProcesses: row.peakProcesses,
          releaseCause: row.releaseCause ?? "task_lost",
          outcome: row.releaseCause === "task_lost" ? "failure" : "success"
        },
        Effect.void
      );
      yield* store.markEvent(row.bindingId);
    }
  });
  const finishStop = Effect.fn("Fleet.finishStop")(function* (binding: FleetStore.Binding) {
    const now = yield* Clock.currentTimeMillis;
    if (!(yield* store.drained(binding, now))) return false;
    yield* checkHousekeeping;
    // Stopping is irreversible. Neither adoption nor an open can select this task.
    const task = yield* provider.stop(binding.taskId);
    yield* collect(binding, true);
    yield* checkHousekeeping;
    yield* store.stopped(task.taskId, task.stoppedAt ?? now, binding.releaseCause ?? "released");
    yield* emitBindings;
    return true;
  });
  const fence = Effect.fn("Fleet.fence")(function* (binding: FleetStore.Binding, cause: string) {
    yield* checkHousekeeping;
    const rows = yield* store.fence(binding, cause);
    const stopped = rows[0];
    if (stopped) yield* finishStop(stopped);
    return stopped !== undefined;
  });
  const drainTask = Effect.fn("Fleet.drainTask")(
    function* (taskId: string, cause = "operator") {
      const bindings = yield* store.findTask(taskId);
      const binding = bindings[0];
      if (binding?.state === "stopping") return yield* finishStop(binding);
      if (binding && binding.state !== "stopped") return yield* fence(binding, cause);
      const task = (yield* store.tasks(undefined)).find((task) => task.taskId === taskId);
      if (!task) return false;
      // A spare can race a claim. Fence its task row before any provider call.
      yield* checkHousekeeping;
      if (task.state !== "stopping") {
        const fenced = yield* sql`UPDATE execution_tasks SET state = 'stopping'
        WHERE task_id = ${taskId} AND state IN ('starting', 'spare') RETURNING task_id`;
        if (fenced.length === 0) return false;
      }
      const remote = (yield* provider.list).find((task) => task.taskId === taskId);
      yield* checkHousekeeping;
      const stopped = remote === undefined ? undefined : yield* provider.stop(taskId);
      yield* checkHousekeeping;
      yield* store.stopped(taskId, stopped?.stoppedAt ?? (yield* Clock.currentTimeMillis), cause);
      return true;
    },
    Effect.mapError((cause) => new FleetError({ operation: "drain", cause }))
  );
  const retireDeployment = Effect.fn("Fleet.retireDeployment")(
    function* (revision: string) {
      yield* store.retireDeployment(revision);
      yield* Effect.forEach(
        (yield* store.tasks(undefined)).filter((task) => task.deploymentRevision === revision),
        (task) => isolate(task.taskId, drainTask(task.taskId, "deployment")),
        { concurrency: 8, discard: true }
      );
    },
    Effect.mapError((cause) => new FleetError({ operation: "drain", cause }))
  );
  const minimumSpares = Math.max(
    1,
    Math.min(config.get("execution.pool.spares"), config.get("execution.fleet.budget"))
  );
  const isolate = <A, E, R>(taskId: string, work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.timeout(config.get("execution.pool.wait")),
      Effect.asVoid,
      Effect.catch((cause) => {
        if (isLeaseLost(cause)) return Effect.fail(cause);
        if (isFleetError(cause) && isLeaseLost(cause.cause)) return Effect.fail(cause.cause);
        return Effect.logWarning("Execution task reconciliation failed", { taskId });
      })
    );
  const housekeeping = Effect.fn("Fleet.housekeeping")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const leaseDuration = config.get("execution.housekeeping.lease");
      const lease = yield* store.lease(options.replicaId, now, leaseDuration);
      if (!lease) return false;
      const guard = Effect.gen(function* () {
        if (
          !(yield* store.renewLease(
            options.replicaId,
            lease.leaseEpoch,
            yield* Clock.currentTimeMillis,
            leaseDuration
          ))
        )
          return yield* new LeaseLost({ leaseEpoch: lease.leaseEpoch });
      }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      const replenishLock = yield* Semaphore.make(1);
      const replenish = Effect.gen(function* () {
        const rollout = yield* store.rollout;
        const revisions = [...new Set([rollout.stagedRevision, rollout.currentRevision])];
        for (const revision of revisions) {
          if (revision === null) continue;
          const window = config.get("execution.pool.wakeWindow");
          const measured = yield* store.target(yield* Clock.currentTimeMillis, window, revision);
          const target = Math.ceil(
            Math.max(
              minimumSpares,
              revision === rollout.currentRevision
                ? (measured.wakes / window) * measured.coldStart
                : 0
            )
          );
          const reserved: string[] = [];
          for (let count = measured.spares; count < target; count++) {
            yield* guard;
            const taskId = yield* Effect.sync(randomUUID);
            if (
              !(yield* store.reserve(
                taskId,
                revision,
                options.replicaId,
                lease.leaseEpoch,
                yield* Clock.currentTimeMillis,
                config.get("execution.fleet.budget")
              ))
            )
              break;
            reserved.push(taskId);
          }
          yield* Effect.forEach(
            reserved,
            (taskId) =>
              isolate(
                taskId,
                Effect.gen(function* () {
                  const started = yield* provider.start({ taskId, deploymentRevision: revision });
                  yield* guard;
                  yield* store.ready(started);
                  yield* notify;
                })
              ),
            { concurrency: 8, discard: true }
          );
          yield* guard;
          if (
            rollout.currentRevision === null &&
            (yield* store.promoteDeployment(revision, minimumSpares, true))
          )
            yield* notify;
        }
      }).pipe(replenishLock.withPermit);
      const reconcileTasks = Effect.gen(function* () {
        const tasks = yield* store.tasks(undefined);
        const observed = yield* provider.list.pipe(
          Effect.timeout(config.get("execution.pool.wait"))
        );
        yield* guard;
        const rollout = yield* store.rollout;
        const retained = new Set([rollout.currentRevision, rollout.stagedRevision]);
        const observedById = new Map(observed.map((task) => [task.taskId, task]));
        yield* Effect.forEach(
          tasks,
          (task) =>
            isolate(
              task.taskId,
              Effect.gen(function* () {
                yield* guard;
                const remote = observedById.get(task.taskId);
                if (remote?.state === "stopped") {
                  const binding = (yield* store.findTask(task.taskId))[0];
                  if (binding)
                    yield* collect(binding, true).pipe(
                      Effect.catchTags({
                        TaskProviderError: (cause) =>
                          cause.reason === "stopped" ? Effect.void : Effect.fail(cause)
                      })
                    );
                  yield* guard;
                  yield* store.stopped(task.taskId, remote.stoppedAt ?? now, "task_lost");
                } else if (task.state === "starting") {
                  if (retained.has(task.deploymentRevision)) {
                    const started = yield* provider.start({
                      taskId: task.taskId,
                      deploymentRevision: task.deploymentRevision
                    });
                    yield* guard;
                    yield* store.ready(started);
                  } else yield* drainTask(task.taskId, "deployment");
                } else if (!remote) {
                  yield* store.stopped(task.taskId, now, "task_lost");
                } else if (
                  task.state === "stopping" ||
                  (task.state === "spare" && !retained.has(task.deploymentRevision))
                )
                  yield* drainTask(task.taskId, "deployment");
              })
            ),
          { concurrency: 8, discard: true }
        );
        const known = new Set(tasks.map((task) => task.taskId));
        yield* Effect.forEach(
          observed.filter((task) => task.state === "running" && !known.has(task.taskId)),
          (task) =>
            isolate(
              task.taskId,
              Effect.gen(function* () {
                yield* guard;
                const recorded =
                  yield* sql`SELECT task_id FROM execution_tasks WHERE task_id = ${task.taskId}`;
                if (recorded.length === 0) {
                  yield* guard;
                  yield* provider.stop(task.taskId);
                }
              })
            ),
          { concurrency: 8, discard: true }
        );
      }).pipe(
        Effect.catchTags({
          TaskProviderError: () => Effect.logWarning("Execution provider observation failed"),
          TimeoutError: () => Effect.logWarning("Execution provider observation timed out")
        })
      );
      const reconcileBindings = Effect.gen(function* () {
        yield* Effect.forEach(
          yield* store.bindings(undefined),
          (binding) =>
            isolate(
              binding.taskId,
              Effect.gen(function* () {
                yield* guard;
                if (binding.state === "stopping") {
                  yield* finishStop(binding);
                  return;
                }
                if (binding.state === "claiming") {
                  const settings = yield* supervisorLimits(binding.companyId);
                  yield* guard;
                  yield* provider.bind(binding.taskId, {
                    companyId: binding.companyId,
                    bindingEpoch: binding.bindingEpoch,
                    ...settings
                  });
                  yield* guard;
                  yield* store.activate(binding);
                }
                yield* collect(binding);
                const idle = yield* limits.get({
                  companyId: binding.companyId,
                  limitId: "execution.company.idle"
                });
                yield* guard;
                const fenced = yield* store.idleFence(
                  binding,
                  yield* Clock.currentTimeMillis,
                  idle.value
                );
                if (fenced[0]) yield* finishStop(fenced[0]);
              })
            ),
          { concurrency: 8, discard: true }
        );
      });
      const work = Effect.gen(function* () {
        yield* Effect.all([reconcileTasks, reconcileBindings, replenish], {
          concurrency: "unbounded"
        }).pipe(
          // Slow or unhealthy bindings must not prevent subsequent spare replenishment.
          Effect.raceFirst(
            Effect.sleep(config.get("execution.housekeeping.interval")).pipe(
              Effect.andThen(replenish),
              Effect.forever
            )
          )
        );
        yield* guard;
        const rollout = yield* store.rollout;
        if (
          rollout.currentRevision === null &&
          rollout.stagedRevision !== null &&
          (yield* store.promoteDeployment(rollout.stagedRevision, minimumSpares, true))
        )
          yield* notify;
        const replaced = yield* store.replaceDeploymentBinding(
          options.replicaId,
          yield* Clock.currentTimeMillis
        );
        if (replaced) {
          yield* isolate(
            replaced.replacement.taskId,
            Effect.gen(function* () {
              const binding = replaced.replacement;
              yield* provider.bind(binding.taskId, {
                companyId: binding.companyId,
                bindingEpoch: binding.bindingEpoch,
                ...(yield* supervisorLimits(binding.companyId))
              });
              yield* guard;
              yield* store.activate(binding);
            })
          );
          yield* isolate(replaced.previous.taskId, finishStop(replaced.previous));
        }
        yield* emitBindings;
        return true;
      });
      return yield* work.pipe(
        Effect.raceFirst(
          Effect.sleep(Math.max(1, Math.floor(leaseDuration / 3))).pipe(
            Effect.andThen(guard),
            Effect.forever
          )
        ),
        Effect.provideService(housekeepingGuard, guard)
      );
    },
    housekeepingLock.withPermitsIfAvailable(1),
    Effect.map(Option.getOrElse(() => false)),
    Effect.mapError((cause) => new FleetError({ operation: "housekeeping", cause }))
  );
  let housekeepingRequested = false;
  const requestHousekeeping = Effect.suspend(() => {
    if (housekeepingRequested) return Effect.void;
    housekeepingRequested = true;
    return housekeeping().pipe(
      Effect.catchTags({ FleetError: () => Effect.logWarning("Execution housekeeping failed") }),
      Effect.ensuring(
        Effect.sync(() => {
          housekeepingRequested = false;
        })
      ),
      Effect.forkIn(scope),
      Effect.asVoid
    );
  });
  const ensure = Effect.fn("Fleet.ensureBinding")(
    function* (companyId: string) {
      const wait = yield* limits.get({ companyId, limitId: "execution.pool.wait" });
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* Effect.gen(function* () {
        let claimed: FleetStore.Binding | undefined;
        while (true) {
          const wake = changed;
          const now = yield* Clock.currentTimeMillis;
          claimed ??= yield* store.claim(companyId, options.replicaId, now, now - startedAt);
          if (claimed) {
            if (!(yield* store.isAdmissibleTask(claimed.taskId))) {
              yield* fence(claimed, "deployment").pipe(
                Effect.catchTags({ TaskProviderError: () => Effect.void })
              );
              claimed = undefined;
              continue;
            }
            if (claimed.state === "active") return claimed;
            const reply = yield* provider
              .bind(claimed.taskId, {
                companyId,
                bindingEpoch: claimed.bindingEpoch,
                ...(yield* supervisorLimits(companyId))
              })
              .pipe(
                Effect.catchTags({
                  TaskProviderError: () => Effect.void
                })
              );
            if (reply) {
              yield* store.activate(claimed);
              const active = (yield* store.findTask(claimed.taskId))[0];
              if (active?.state === "active" && (yield* store.isAdmissibleTask(active.taskId)))
                return active;
              claimed = active?.state === "active" ? active : undefined;
              continue;
            }
          }
          yield* requestHousekeeping;
          yield* Effect.sleep(50).pipe(Effect.raceFirst(Deferred.await(wake)));
        }
      }).pipe(
        Effect.timeoutOrElse({ duration: wait.value, orElse: () => Effect.fail(busy(wait.value)) })
      );
    },
    Effect.catchTags({ SchemaError: Effect.die }),
    Effect.mapError((cause) => (isLifecycleError(cause) ? cause : lifecycleFailure(cause)))
  );
  const releaseActivity = Effect.fn("Fleet.releaseActivity")(function* (
    companyId: string,
    unlock: Effect.Effect<void, SqlError>,
    binding?: FleetStore.Binding
  ) {
    yield* unlock;
    const now = yield* Clock.currentTimeMillis;
    yield* store.touch(companyId, now);
    if (binding) {
      // A normal final settlement removes crash protection when all callers have
      // released. A crashed owner leaves the absolute deadline protection intact.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${FleetStore.bindingLock(binding.bindingId)}, 0)) AS acquired`;
          if (rows[0]?.acquired)
            yield* sql`UPDATE execution_bindings SET protected_until = 0 WHERE binding_id = ${binding.bindingId}`;
        })
      );
    }
  }, Effect.orDie);
  const lifecycle = ExecutionLifecycle.ExecutionLifecycle.of({
    connect: Effect.fn("Fleet.connect")(function* (companyId) {
      yield* Effect.acquireRelease(
        activity.hold(FleetStore.companyLock(companyId)).pipe(Effect.mapError(lifecycleFailure)),
        (unlock) => releaseActivity(companyId, unlock)
      ).pipe(Effect.asVoid);
      yield* store
        .touch(companyId, yield* Clock.currentTimeMillis)
        .pipe(Effect.mapError(lifecycleFailure));
      yield* ensure(companyId);
    }),
    acquire: Effect.fn("Fleet.acquire")(function* (companyId, patchId) {
      const now = yield* Clock.currentTimeMillis;
      const paused = yield* store
        .pausedUntil(companyId, patchId)
        .pipe(Effect.mapError(lifecycleFailure));
      if (!options.dev && paused > now) {
        const threshold = yield* limits
          .get({ companyId, limitId: "execution.breaker.kills" })
          .pipe(Effect.mapError(lifecycleFailure));
        return yield* new ExecutionLifecycle.LifecycleError({
          code: "patch_paused",
          status: 429,
          retryAfterSeconds: Math.ceil((paused - now) / 1000),
          scope: "patch",
          limitId: "execution.breaker.kills",
          value: threshold.value
        });
      }
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const binding = yield* restore(ensure(companyId));
            const unlock = yield* activity
              .hold(FleetStore.bindingLock(binding.bindingId))
              .pipe(Effect.mapError(lifecycleFailure));
            const protectedBinding = yield* store
              .protect(
                binding,
                (yield* Clock.currentTimeMillis) + maximumCallMs,
                yield* Clock.currentTimeMillis
              )
              .pipe(
                Effect.mapError(lifecycleFailure),
                Effect.onError(() => unlock.pipe(Effect.orDie))
              );
            if (protectedBinding[0])
              return {
                binding: { taskId: binding.taskId, bindingEpoch: binding.bindingEpoch },
                release: releaseActivity(companyId, unlock, binding)
              };
            yield* unlock.pipe(Effect.mapError(lifecycleFailure));
          }
        })
      );
    })
  });
  const route = Effect.fn("Fleet.route")(
    function* (
      companyId: string,
      selected: Executor.ExecutionBinding | undefined,
      operation: "bind" | "invoke"
    ) {
      if (!selected)
        return yield* new Executor.ExecutionError({ operation, reason: "binding_conflict" });
      const binding = (yield* store.findTask(selected.taskId))[0];
      if (
        !binding ||
        binding.companyId !== companyId ||
        binding.bindingEpoch !== selected.bindingEpoch ||
        binding.state === "stopped"
      )
        return yield* new Executor.ExecutionError({ operation, reason: "binding_conflict" });
      return selected;
    },
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.fail(new Executor.ExecutionError({ operation: "bind", reason: "transport", cause })),
      SchemaError: Effect.die
    })
  );
  const executor = Executor.Executor.of({
    bind: Effect.fn("Fleet.bindBundle")(function* (bundle: GuestProtocol.Bundle, selected) {
      const binding = yield* route(bundle.companyId, selected, "bind");
      const settings = yield* supervisorLimits(bundle.companyId).pipe(
        Effect.mapError(
          (cause) => new Executor.ExecutionError({ operation: "bind", reason: "transport", cause })
        )
      );
      const reply = yield* provider
        .bind(binding.taskId, {
          companyId: bundle.companyId,
          bindingEpoch: binding.bindingEpoch,
          bundle,
          ...settings
        })
        .pipe(Effect.mapError(executionError));
      if (!reply.binding || reply.processGeneration === undefined)
        return yield* new Executor.ExecutionError({ operation: "bind", reason: "protocol" });
      return { binding: reply.binding, processGeneration: reply.processGeneration };
    }),
    invoke: Effect.fn("Fleet.invoke")(function* (request: GuestProtocol.Invoke, selected) {
      const binding = yield* route(request.binding.companyId, selected, "invoke");
      return yield* provider
        .invoke(binding.taskId, { bindingEpoch: binding.bindingEpoch, request })
        .pipe(Effect.mapError(executionError));
    })
  });
  if (options.automaticHousekeeping !== false)
    yield* housekeeping().pipe(
      Effect.catchTags({
        FleetError: (error) =>
          Effect.logWarning("Execution housekeeping failed", { operation: error.operation })
      }),
      Effect.andThen(Effect.sleep(config.get("execution.housekeeping.interval"))),
      Effect.forever,
      Effect.forkIn(scope)
    );
  return {
    lifecycle,
    executor,
    housekeeping,
    drainTask,
    retireDeployment,
    stageDeployment: (revision: string) =>
      store
        .stageDeployment(revision)
        .pipe(Effect.mapError((cause) => new FleetError({ operation: "stage", cause }))),
    promoteDeployment: (revision: string) =>
      store.promoteDeployment(revision, minimumSpares).pipe(
        Effect.tap(() => notify),
        Effect.mapError((cause) => new FleetError({ operation: "promote", cause }))
      ),
    ensureBinding: ensure,
    releaseCompany: Effect.fn("Fleet.releaseCompany")(
      function* (companyId: string) {
        const binding = (yield* store.findCompany(companyId))[0];
        return binding ? yield* fence(binding, "operator") : false;
      },
      Effect.mapError((cause) => new FleetError({ operation: "release", cause }))
    ),
    adopt: Effect.fn("Fleet.adopt")(
      function* (binding: Executor.ExecutionBinding, expectedOwner: string) {
        const current = (yield* store.findTask(binding.taskId))[0];
        if (
          !current ||
          current.bindingEpoch !== binding.bindingEpoch ||
          current.ownerId !== expectedOwner
        )
          return false;
        const adopted = (yield* store.adopt(
          current,
          options.replicaId,
          yield* Clock.currentTimeMillis
        ))[0];
        if (!adopted) return false;
        yield* provider.bind(adopted.taskId, {
          companyId: adopted.companyId,
          bindingEpoch: adopted.bindingEpoch,
          ...(yield* supervisorLimits(adopted.companyId))
        });
        yield* store.activate(adopted);
        return true;
      },
      Effect.mapError((cause) => new FleetError({ operation: "bind", cause }))
    ),
    history: (companyId: string) =>
      store
        .history(companyId)
        .pipe(Effect.mapError((cause) => new FleetError({ operation: "history", cause }))),
    setLimitOverride: Effect.fn("Fleet.setLimitOverride")(function* (
      input: Parameters<typeof limits.setOverride>[0]
    ) {
      const result = yield* limits.setOverride(input);
      const binding = (yield* store.findCompany(input.companyId))[0];
      if (binding?.state === "active" && (yield* store.isAdmissibleTask(binding.taskId)))
        yield* provider.bind(binding.taskId, {
          companyId: input.companyId,
          bindingEpoch: binding.bindingEpoch,
          ...(yield* supervisorLimits(input.companyId))
        });
      return result;
    }),
    removeLimitOverride: Effect.fn("Fleet.removeLimitOverride")(function* (
      input: Parameters<typeof limits.removeOverride>[0]
    ) {
      const result = yield* limits.removeOverride(input);
      const binding = (yield* store.findCompany(input.companyId))[0];
      if (binding?.state === "active" && (yield* store.isAdmissibleTask(binding.taskId)))
        yield* provider.bind(binding.taskId, {
          companyId: input.companyId,
          bindingEpoch: binding.bindingEpoch,
          ...(yield* supervisorLimits(input.companyId))
        });
      return result;
    })
  };
});
