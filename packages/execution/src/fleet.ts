import * as WideEvents from "@patchy/analytics/wide-events";
import type { GuestProtocol } from "@patchy/api";
import type { StatsReply } from "@patchy/api/management";
import * as DeploymentConfig from "@patchy/limits/deployment-config";
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import * as Executor from "@patchy/runtime/executor";
import * as ExecutionLifecycle from "@patchy/runtime/execution-lifecycle";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as ActiveMembers from "./ActiveMembers.js";
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
/** No host has registered the revision, so none is running it to warm its spares. */
export class RevisionNotRegistered extends Schema.TaggedError<RevisionNotRegistered>()(
  "FleetRevisionNotRegistered",
  { revision: Schema.String }
) {
  override get message() {
    return `No host has registered deployment revision ${this.revision}; deploy its hosts first.`;
  }
}
/** The revision's hosts did not warm enough spares to promote it in time. */
export class SparesNotReady extends Schema.TaggedError<SparesNotReady>()("FleetSparesNotReady", {
  revision: Schema.String,
  minimumSpares: Schema.Number
}) {
  override get message() {
    return `Deployment revision ${this.revision} did not reach ${this.minimumSpares} ready spares in time; it stays staged.`;
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
/**
 * One admission's search for its company's server, across its tries: when it began, how it
 * found the server so far (already `bound`, a ready `spare`, or a `launch` it waited for), and
 * the end of its one `execution.pool.wait`, set by its first try that has to claim.
 */
interface Search {
  readonly startedAt: number;
  found?: "bound" | "spare" | "launch";
  until?: number;
}
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

/** A prewarm leaves at least this many spares ready for opens that cannot wait. */
const prewarmReserve = 1;

/** A revision promotes once this many of its full spares are ready. */
const minimumSparesOf = (config: Effect.Success<typeof DeploymentConfig.load>) =>
  Math.max(1, Math.min(config.get("execution.pool.spares"), config.get("execution.fleet.budget")));

/**
 * Turns small boxes on or off for the whole fleet, as the operator command does: one-member
 * companies' next claims are small while it is on, and every claim is full while it is off.
 * Live bindings keep the box they have.
 */
export const setSmallBoxes = Effect.fn("Fleet.setSmallBoxes")(function* (on: boolean) {
  const store = yield* FleetStore.make;
  yield* store.setSmallBoxes(on);
});

/**
 * The switch, ready small tasks not stopped by state, and every row never admitted at readiness
 * and not stopped that asked for a small box or was seen running at one, from one database
 * snapshot: what a rollback past small boxes waits to see empty.
 */
export const smallBoxesStatus = Effect.flatMap(FleetStore.make, (store) => store.smallBoxesStatus);

/**
 * Stages `revision` and promotes it once its hosts have warmed its spares,
 * polling each second for at most `timeout`. It moves rollout rows only: the
 * revision's hosts registered it and warm its spares, so this runs in any
 * process beside them on the platform database, such as a one-off deploy task.
 * Promoting an earlier revision is a rollback.
 */
export const promote = Effect.fn("Fleet.promote")(function* (
  revision: string,
  timeout: Duration.Input
) {
  const store = yield* FleetStore.make;
  const minimumSpares = minimumSparesOf(yield* DeploymentConfig.load);
  // Done already, as when a first deployment's hosts promoted it themselves.
  const current = store.rollout.pipe(
    Effect.map((rollout) => rollout.currentRevision === revision && rollout.stagedRevision === null)
  );
  if (yield* current) return;
  if (!(yield* store.stageDeployment(revision)))
    return yield* new RevisionNotRegistered({ revision });
  const promoted = Effect.gen(function* () {
    return (yield* store.promoteDeployment(revision, minimumSpares)) || (yield* current);
  });
  yield* promoted.pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("1 second") }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new SparesNotReady({ revision, minimumSpares }))
    })
  );
});

/** Host code, not a service deployment. One instance is scoped to one host replica. */
export const make = Effect.fn("Fleet.make")(function* (options: Options) {
  const random = yield* SecureRandom.SecureRandom;
  const provider = yield* TaskProvider.TaskProvider;
  const limits = yield* OperatingLimits.OperatingLimits;
  const config = yield* DeploymentConfig.load;
  const maximumCallMs =
    (yield* ContractLimits.get("tier2.action.deadline")) +
    (yield* ContractLimits.get("tier2.settlement.cleanup"));
  const events = yield* WideEvents.WideEvents;
  const members = yield* ActiveMembers.ActiveMembers;
  const fleetStore = yield* FleetStore.make;
  // Claims size the box by the company's active members, read on the claim's own transaction.
  const store = {
    ...fleetStore,
    claim: (...args: Parameters<typeof fleetStore.claim>) =>
      fleetStore.claim(...args).pipe(Effect.provideService(ActiveMembers.ActiveMembers, members)),
    replaceDeploymentBinding: (owner: string, now: number) =>
      fleetStore
        .replaceDeploymentBinding(owner, now)
        .pipe(Effect.provideService(ActiveMembers.ActiveMembers, members))
  };
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
  const readStats = Effect.fn("Fleet.readStats")(function* (
    binding: FleetStore.Binding,
    stopped = false
  ) {
    yield* checkHousekeeping;
    return yield* provider.stats(binding.taskId, { bindingEpoch: binding.bindingEpoch }).pipe(
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
  });
  const collect = Effect.fn("Fleet.collectReports")(function* (
    binding: FleetStore.Binding,
    stats: StatsReply
  ) {
    yield* checkHousekeeping;
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
    // The box each process ran on, for timing starts and deadlines by its size.
    const cpu = stats.reports.length === 0 ? undefined : yield* store.taskCpu(binding.taskId);
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
      if (inserted) yield* events.emit(cpu === undefined ? report.event : { ...report.event, cpu });
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
          cpu: row.cpu,
          spareWaitMs: row.spareWaitMs,
          peakProcesses: row.peakProcesses,
          releaseCause: row.releaseCause ?? "task_lost",
          ...(row.agentOnly === null ? {} : { agentOnly: row.agentOnly }),
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
    // Persist and acknowledge final process reports while the management listener still exists.
    const quiesceFailure = yield* provider.quiesce(binding.taskId, binding.bindingEpoch).pipe(
      Effect.catchTags({
        TaskProviderError: (cause) =>
          cause.reason === "stale_epoch" ? provider.quiesce(binding.taskId, 0) : Effect.fail(cause)
      }),
      Effect.as(undefined),
      Effect.catchTags({
        TaskProviderError: (cause) =>
          cause.reason === "transport" || cause.reason === "stopped"
            ? Effect.succeed(cause)
            : Effect.fail(cause)
      })
    );
    const stats = yield* readStats(binding, true).pipe(
      Effect.catchTags({
        TaskProviderError: (cause) =>
          quiesceFailure && (cause.reason === "transport" || cause.reason === "stopped")
            ? Effect.void
            : Effect.fail(cause)
      })
    );
    if (quiesceFailure && stats && !stats.stopped) return yield* quiesceFailure;
    // Only an unavailable supervisor permits losing final reports. Storage or acknowledgement
    // failure after quiescence leaves the task fenced and alive for the next collection attempt.
    if (stats) yield* collect(binding, stats);
    yield* checkHousekeeping;
    const task = yield* provider.stop(binding.taskId);
    yield* checkHousekeeping;
    if (!stats)
      yield* sql`UPDATE execution_bindings SET release_cause = 'task_lost'
        WHERE binding_id = ${binding.bindingId} AND binding_epoch = ${binding.bindingEpoch}
          AND state = 'stopping'`;
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
      yield* checkHousekeeping;
      // A drain completes only on evidence. A row that asked for a small box and certainly
      // launched nothing has nothing to stop, unless the provider lists its task after all: then
      // it is uncertain from now on and stopped like any other. Every other row, a full one
      // included, waits for the provider to confirm its task stopped.
      if (TaskProvider.isSmall(task) && task.readyAt === null && task.launchedNothing) {
        const seen = (yield* provider.list).some((remote) => remote.taskId === taskId);
        yield* checkHousekeeping;
        if (seen) yield* store.launchSeen([taskId]);
        else if (yield* store.stopUnlaunched(taskId, yield* Clock.currentTimeMillis)) return true;
      }
      const stopped = yield* provider.stop(taskId);
      yield* checkHousekeeping;
      yield* store.stopped(taskId, stopped.stoppedAt ?? (yield* Clock.currentTimeMillis), cause);
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
  const minimumSpares = minimumSparesOf(config);
  const smallFloor = config.get("execution.pool.smallSpares");
  const lastBudgetWarningAt = new Map<string, number>();
  /**
   * Launches a reserved or retried `starting` row at the size it asked for. Each attempt is
   * counted on the row before it is sent and taken back only when the provider refused it
   * outright, so the row records whether anything was ever launched for it. A ready task is
   * admitted at the size the provider observed, or drained when it may not be a spare.
   */
  const launch = Effect.fn("Fleet.launch")(function* (
    task: Pick<FleetStore.Task, "taskId" | "deploymentRevision" | "cpu" | "memory">
  ) {
    const size = { cpu: task.cpu, memory: task.memory };
    if (!(yield* store.launching(task.taskId))) return;
    const started = yield* provider
      .start({ taskId: task.taskId, deploymentRevision: task.deploymentRevision, size })
      .pipe(
        Effect.catchTags({
          TaskLaunchRefused: (refused) =>
            store.launchRefused(task.taskId).pipe(Effect.andThen(Effect.fail(refused)))
        })
      );
    if (started.size?.cpu !== size.cpu || started.size.memory !== size.memory)
      yield* Effect.logError("Execution task started at a size other than it asked for", {
        taskId: task.taskId,
        requested: size,
        observed: started.size ?? null
      });
    yield* checkHousekeeping;
    const admitted = yield* store.ready(started, size);
    if (admitted === "drain") return yield* drainTask(task.taskId, "deployment");
    if (admitted === "spare") yield* notify;
  });
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
      const selected = yield* store.rollout;
      if ((selected.stagedRevision ?? selected.currentRevision) !== options.deploymentRevision) {
        yield* sql`DELETE FROM execution_housekeeping WHERE owner_id = ${options.replicaId}`;
        return false;
      }
      const now = yield* Clock.currentTimeMillis;
      const leaseDuration = config.get("execution.housekeeping.lease");
      const lease = yield* store.lease(
        options.replicaId,
        options.deploymentRevision,
        now,
        leaseDuration
      );
      if (!lease) return false;
      const guard = Effect.gen(function* () {
        if (
          !(yield* store.renewLease(
            options.replicaId,
            options.deploymentRevision,
            lease.leaseEpoch,
            yield* Clock.currentTimeMillis,
            leaseDuration
          ))
        ) {
          yield* sql`DELETE FROM execution_housekeeping
            WHERE owner_id = ${options.replicaId} AND lease_epoch = ${lease.leaseEpoch}`;
          return yield* new LeaseLost({ leaseEpoch: lease.leaseEpoch });
        }
      }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      const replenishLock = yield* Semaphore.make(1);
      const inventoryRecorded = yield* Deferred.make<void>();
      const window = config.get("execution.pool.wakeWindow");
      const grace = config.get("execution.pool.wait");
      // One snapshot of the switch plans the whole pass: targets, trim and every replenish in it.
      // Writes that would create or keep a small spare recheck it under the rollout row's lock.
      const smallBoxes = selected.smallBoxes;
      // A size's spare target: the floor or the wake rate times the cold start, whichever is
      // more, plus companies waiting for that size; a staged revision warms to the full floor.
      // There is no small target while small boxes are off, nor for a staged revision.
      const targetOf = (demand: FleetStore.Demand, size: TaskProvider.Size, isCurrent: boolean) => {
        if (TaskProvider.isSmall(size) && !(smallBoxes && isCurrent)) return 0;
        const floor = TaskProvider.isSmall(size) ? smallFloor : minimumSpares;
        const baseline = Math.ceil(
          Math.max(floor, isCurrent ? (demand.wakes / window) * demand.coldStart : 0)
        );
        return isCurrent ? baseline + demand.waiting : baseline;
      };
      const sizes = [
        { name: "full", size: TaskProvider.full },
        { name: "small", size: TaskProvider.small }
      ] as const;
      // Reclaim surplus ready spares of the current revision, each size to its own target, once
      // their retry grace passes. Runs beside `replenish` so slow provider stops never block
      // reservations using free budget. Ready small spares are always offered to the trim, even
      // at their target, since only its recheck under the rollout row's lock may keep them.
      const trimSurplus = Effect.gen(function* () {
        yield* Deferred.await(inventoryRecorded);
        const rollout = yield* store.rollout;
        if (rollout.currentRevision === null) return;
        const currentNow = yield* Clock.currentTimeMillis;
        const measured = yield* store.target(
          currentNow,
          window,
          rollout.currentRevision,
          smallBoxes
        );
        for (const { name, size } of sizes) {
          const keep = targetOf(measured[name], size, true);
          const ready = measured[name].readySpares;
          if (TaskProvider.isSmall(size) ? ready === 0 : ready <= keep) continue;
          yield* guard;
          const trimmed = yield* store.trimSpares(
            rollout.currentRevision,
            size,
            keep,
            currentNow - grace
          );
          yield* Effect.forEach(
            trimmed,
            (taskId) => isolate(taskId, drainTask(taskId, "deployment")),
            { concurrency: 8, discard: true }
          );
        }
      });
      // Reserves up to `target` spares of `size` for `revision` and launches them. Answers
      // whether a deficit was refused for budget.
      const fill = Effect.fn("Fleet.fill")(function* (
        revision: string,
        name: "full" | "small",
        size: TaskProvider.Size,
        spares: number,
        target: number
      ) {
        const reserved: string[] = [];
        const budget = config.get("execution.fleet.budget");
        let budgetSpares: number | undefined;
        for (let count = spares; count < target; count++) {
          yield* guard;
          const taskId = yield* random.uuidV4();
          const result = yield* store.reserve(
            taskId,
            revision,
            size,
            options.replicaId,
            lease.leaseEpoch,
            yield* Clock.currentTimeMillis,
            budget
          );
          if (result.outcome !== "reserved") {
            if (result.outcome === "budget") budgetSpares = result.spares;
            break;
          }
          reserved.push(taskId);
        }
        if (budgetSpares !== undefined) {
          const warnAt = yield* Clock.currentTimeMillis;
          const key = `${revision}/${name}`;
          const last = lastBudgetWarningAt.get(key);
          if (
            last === undefined ||
            warnAt - last >= config.get("execution.housekeeping.interval")
          ) {
            lastBudgetWarningAt.set(key, warnAt);
            // Keep this single-line and unannotated: ECS awslogs has no multiline grouping, so
            // CloudWatch's `parse` query relies on all five fields landing on one line.
            yield* Effect.logWarning(
              `Execution fleet budget exhausted revision=${revision} size=${name} budget=${budget} target=${target} spares=${budgetSpares}`
            );
          }
        }
        yield* Effect.forEach(
          reserved,
          (taskId) =>
            isolate(
              taskId,
              launch({ taskId, deploymentRevision: revision, cpu: size.cpu, memory: size.memory })
            ),
          { concurrency: 8, discard: true }
        );
        return budgetSpares !== undefined;
      });
      // Full deficits come first, the staged revision's and then the current one's. Small spares,
      // the current revision's only, are reserved only while no full deficit has been refused for
      // budget in this pass, a replenish that reruns inside it included; a small spare is never
      // stopped to make room for a full one.
      let fullRefused = false;
      const replenish = Effect.gen(function* () {
        yield* Deferred.await(inventoryRecorded);
        const rollout = yield* store.rollout;
        const revisions = [...new Set([rollout.stagedRevision, rollout.currentRevision])];
        let current:
          { readonly full: FleetStore.Demand; readonly small: FleetStore.Demand } | undefined;
        for (const revision of revisions) {
          if (revision === null) continue;
          const isCurrent = revision === rollout.currentRevision;
          const measured = yield* store.target(
            yield* Clock.currentTimeMillis,
            window,
            revision,
            smallBoxes
          );
          if (isCurrent) current = measured;
          const target = targetOf(measured.full, TaskProvider.full, isCurrent);
          if (yield* fill(revision, "full", TaskProvider.full, measured.full.spares, target))
            fullRefused = true;
          yield* guard;
          if (
            rollout.currentRevision === null &&
            (yield* store.promoteDeployment(revision, minimumSpares, true))
          )
            yield* notify;
        }
        if (rollout.currentRevision === null || current === undefined || fullRefused) return;
        const target = targetOf(current.small, TaskProvider.small, true);
        yield* fill(
          rollout.currentRevision,
          "small",
          TaskProvider.small,
          current.small.spares,
          target
        );
      }).pipe(replenishLock.withPermit);
      const reconcileTasks = Effect.gen(function* () {
        const tasks = yield* store.tasks(undefined);
        const observed = yield* provider.list.pipe(
          Effect.timeout(config.get("execution.pool.wait"))
        );
        yield* guard;
        // A row whose task runs certainly launched something, whatever its count says.
        const running = new Set(
          observed.flatMap((remote) => (remote.state === "running" ? [remote.taskId] : []))
        );
        const seen = tasks.flatMap((task) => (running.has(task.taskId) ? [task.taskId] : []));
        if (seen.length > 0) yield* store.launchSeen(seen);
        // Account for reappearing stopped rows before replenishment can spend their budget.
        const known = new Set(tasks.map((task) => task.taskId));
        const orphans: TaskProvider.Task[] = [];
        for (const task of observed) {
          if (task.state === "running" && !known.has(task.taskId)) {
            yield* guard;
            if (yield* store.recordOrphan(task, now)) orphans.push(task);
          }
        }
        yield* Deferred.succeed(inventoryRecorded, undefined);
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
                    yield* readStats(binding, true).pipe(
                      Effect.flatMap((stats) => collect(binding, stats)),
                      Effect.catchTags({
                        TaskProviderError: (cause) =>
                          cause.reason === "stopped" ? Effect.void : Effect.fail(cause)
                      })
                    );
                  yield* guard;
                  yield* store.stopped(task.taskId, remote.stoppedAt ?? now, "task_lost");
                } else if (task.state === "starting") {
                  // A retry asks for the size on the row, so its launch token always carries the
                  // same size. A small row still starting while small boxes are off, or no
                  // longer of the current revision, is drained.
                  if (
                    retained.has(task.deploymentRevision) &&
                    (!TaskProvider.isSmall(task) ||
                      (smallBoxes && task.deploymentRevision === rollout.currentRevision))
                  )
                    yield* launch(task);
                  else yield* drainTask(task.taskId, "deployment");
                } else if (
                  task.state === "stopping" ||
                  (task.state === "spare" && !retained.has(task.deploymentRevision))
                )
                  yield* drainTask(task.taskId, "deployment");
                else if (
                  task.state === "spare" &&
                  TaskProvider.isSmall(task) &&
                  task.deploymentRevision !== rollout.currentRevision
                ) {
                  // Small spares belong to the current revision only, never a staged one. The
                  // fence rechecks that before any provider call: a spare whose revision was
                  // promoted since, or that a company claimed since, is left alone.
                  if (yield* store.fenceSmallSpare(task.taskId))
                    yield* drainTask(task.taskId, "deployment");
                }
              })
            ),
          { concurrency: 8, discard: true }
        );
        yield* Effect.forEach(
          orphans,
          (task) =>
            isolate(
              task.taskId,
              Effect.gen(function* () {
                yield* guard;
                const stopped = yield* provider.stop(task.taskId);
                yield* guard;
                yield* store.stopped(task.taskId, stopped.stoppedAt ?? now, "task_lost");
              })
            ),
          { concurrency: 8, discard: true }
        );
      }).pipe(
        Effect.catchTags({
          TaskProviderError: () => Effect.logWarning("Execution provider observation failed"),
          TimeoutError: () => Effect.logWarning("Execution provider observation timed out")
        }),
        Effect.ensuring(Deferred.succeed(inventoryRecorded, undefined))
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
                yield* collect(binding, yield* readStats(binding));
                // The documents' tail follows the box: a small one's is shorter.
                const idle = yield* limits.getMany({
                  companyId: binding.companyId,
                  limits: {
                    documents: "execution.company.idle",
                    small: "execution.company.smallIdle",
                    agents: "execution.company.agentIdle"
                  }
                });
                yield* guard;
                const fenced = yield* store.idleFence(binding, yield* Clock.currentTimeMillis, {
                  idleMs: TaskProvider.isSmall(binding) ? idle.small.value : idle.documents.value,
                  agentIdleMs: idle.agents.value
                });
                if (fenced[0]) yield* finishStop(fenced[0]);
              })
            ),
          { concurrency: 8, discard: true }
        );
      });
      const work = Effect.gen(function* () {
        yield* Effect.all([reconcileTasks, reconcileBindings, trimSurplus, replenish], {
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
        yield* store.sweepWaits(yield* Clock.currentTimeMillis).pipe(
          Effect.catchTags({
            SqlError: () => Effect.logWarning("Execution pool wait sweep failed")
          })
        );
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
  /**
   * The company's admissible binding, claiming a spare for `caller` when it has none and
   * waiting for a launched one when the pool is empty, until the search's one
   * `execution.pool.wait` runs out. An empty-pool miss records the company's wait inside `claim`
   * so housekeeping counts it across replicas. It records how it found the server on `search`. A
   * prewarm's work is refused at once instead: its prewarm already claimed what it could.
   */
  const find = Effect.fn("Fleet.find")(
    function* (companyId: string, caller: ExecutionLifecycle.Caller, search: Search) {
      // A warm company's active binding needs no claim. `protect` still decides admission
      // against the same epoch, state and task; any miss takes the claim loop, which fences.
      const warm = (yield* store.findAdmissible(companyId))[0];
      if (warm) {
        search.found ??= "bound";
        return warm;
      }
      if (caller === "prewarm") return yield* busy(0);
      const wait = yield* limits.get({ companyId, limitId: "execution.pool.wait" });
      search.until ??= search.startedAt + wait.value;
      const until = search.until;
      return yield* Effect.gen(function* () {
        let claimed: FleetStore.Binding | undefined;
        while (true) {
          const wake = changed;
          const now = yield* Clock.currentTimeMillis;
          if (claimed === undefined) {
            claimed = yield* store.claim(
              companyId,
              options.replicaId,
              now,
              now - search.startedAt,
              FleetStore.clocksOf(caller, now),
              undefined,
              until
            );
            if (claimed === undefined) search.found = "launch";
          }
          if (claimed) {
            if (!(yield* store.isAdmissibleTask(claimed.taskId))) {
              yield* fence(claimed, "deployment").pipe(
                Effect.catchTags({ TaskProviderError: () => Effect.void })
              );
              claimed = undefined;
              continue;
            }
            if (search.found !== "launch")
              search.found = claimed.state === "active" ? (search.found ?? "bound") : "spare";
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
        Effect.timeoutOrElse({
          duration: Math.max(0, search.until - (yield* Clock.currentTimeMillis)),
          orElse: () => Effect.fail(busy(wait.value))
        })
      );
    },
    Effect.catchTags({ SchemaError: Effect.die }),
    Effect.mapError((cause) => (isLifecycleError(cause) ? cause : lifecycleFailure(cause)))
  );
  const ensure = Effect.fn("Fleet.ensureBinding")(function* (
    companyId: string,
    caller: ExecutionLifecycle.Caller = "page"
  ) {
    return yield* find(companyId, caller, {
      startedAt: yield* Clock.currentTimeMillis,
      found: "bound"
    });
  });
  const releaseActivity = Effect.fn("Fleet.releaseActivity")(function* (
    companyId: string,
    unlock: Effect.Effect<void, SqlError>,
    settled?: { readonly binding: FleetStore.Binding; readonly caller: ExecutionLifecycle.Caller }
  ) {
    if (settled === undefined) {
      // A document letting go runs the documents' clock; a pass that finds it gone first
      // starts that window no earlier than then.
      yield* unlock;
      return yield* store.touch(companyId, yield* Clock.currentTimeMillis);
    }
    // Settled work runs its caller's clock while it still holds the binding, so no pass finds
    // the binding free with the clock not yet run. It lets go whatever came of that.
    const clocked = yield* Effect.exit(
      store.touch(companyId, yield* Clock.currentTimeMillis, settled.caller)
    );
    yield* unlock;
    // A normal final settlement removes crash protection when all callers have released. A
    // crashed owner, or a settlement whose clock didn't run, leaves the absolute deadline
    // protection intact.
    if (Exit.isSuccess(clocked)) yield* store.release(settled.binding);
    else yield* Effect.logWarning("A settled call's idle clock was not run", clocked.cause);
  }, Effect.orDie);
  const lifecycle = ExecutionLifecycle.ExecutionLifecycle.of({
    connect: Effect.fn("Fleet.connect")(function* (companyId) {
      const now = yield* Clock.currentTimeMillis;
      const search: Search = { startedAt: now };
      const searched = Effect.flatMap(Clock.currentTimeMillis, (end) =>
        WideEvents.enrich({
          ...(search.found === undefined ? {} : { companyBind: search.found }),
          bindWaitMs: Math.max(0, end - now)
        })
      );
      yield* Effect.gen(function* () {
        yield* Effect.acquireRelease(
          activity.hold(FleetStore.companyLock(companyId)).pipe(Effect.mapError(lifecycleFailure)),
          (unlock) => releaseActivity(companyId, unlock)
        ).pipe(Effect.asVoid);
        yield* find(companyId, "page", search);
        // After the bind, so a binding an agent claimed meanwhile still starts the documents' clock.
        yield* store
          .touch(companyId, yield* Clock.currentTimeMillis)
          .pipe(Effect.mapError(lifecycleFailure));
      }).pipe(Effect.onExit(() => searched));
    }),
    prewarm: Effect.fn("Fleet.prewarm")(
      function* (companyId) {
        const startedAt = yield* Clock.currentTimeMillis;
        // Before any claim, so no pass finds the claimed binding with no clock run and no holder.
        yield* Effect.acquireRelease(activity.hold(FleetStore.prewarmLock(companyId)), (unlock) =>
          unlock.pipe(Effect.orDie)
        ).pipe(Effect.asVoid);
        const followed = store.findCompany(companyId).pipe(
          Effect.map(
            ([binding]) =>
              binding !== undefined &&
              Math.max(binding.lastActivityAt, binding.agentActivityAt) >= startedAt
          ),
          Effect.catch(() => Effect.succeed(false))
        );
        if ((yield* store.findAdmissible(companyId))[0])
          return { found: "bound" as const, followed };
        const now = yield* Clock.currentTimeMillis;
        const claimed = yield* store.claim(
          companyId,
          options.replicaId,
          now,
          0,
          FleetStore.clocksOf("prewarm", now),
          { reserve: prewarmReserve, budget: config.get("execution.fleet.budget") }
        );
        if (claimed === undefined) return { found: "full" as const, followed };
        if (claimed.state === "active") return { found: "bound" as const, followed };
        if (!(yield* store.isAdmissibleTask(claimed.taskId))) {
          yield* fence(claimed, "deployment");
          return { found: "full" as const, followed };
        }
        // A bind that fails leaves the claim for housekeeping to bind, as a call's would.
        const reply = yield* provider
          .bind(claimed.taskId, {
            companyId,
            bindingEpoch: claimed.bindingEpoch,
            ...(yield* supervisorLimits(companyId))
          })
          .pipe(Effect.catchTags({ TaskProviderError: () => Effect.void }));
        if (reply) yield* store.activate(claimed);
        return { found: "spare" as const, followed };
      },
      Effect.catchTags({ SchemaError: Effect.die }),
      Effect.mapError((cause) => (isLifecycleError(cause) ? cause : lifecycleFailure(cause)))
    ),
    acquire: Effect.fn("Fleet.acquire")(function* (companyId, patchId, caller) {
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
      // The call's event says how it found its company's server and how long it waited, a
      // refused wait included.
      const search: Search = { startedAt: now };
      const searched = Effect.flatMap(Clock.currentTimeMillis, (end) =>
        WideEvents.enrich({
          ...(search.found === undefined ? {} : { companyBind: search.found }),
          bindWaitMs: Math.max(0, end - now)
        })
      );
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            // A refused or abandoned wait is recorded too.
            const binding = yield* restore(find(companyId, caller, search)).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && search.until !== undefined ? searched : Effect.void
              )
            );
            const unlock = yield* activity
              .hold(FleetStore.bindingLock(binding.bindingId))
              .pipe(Effect.mapError(lifecycleFailure));
            const protectedBinding = yield* store
              .protect(
                binding,
                (yield* Clock.currentTimeMillis) + maximumCallMs,
                yield* Clock.currentTimeMillis,
                caller
              )
              .pipe(
                Effect.mapError(lifecycleFailure),
                Effect.onError(() => unlock.pipe(Effect.orDie))
              );
            if (protectedBinding[0]) {
              yield* WideEvents.enrich({ cpu: protectedBinding[0].cpu });
              yield* searched;
              return {
                binding: { taskId: binding.taskId, bindingEpoch: binding.bindingEpoch },
                release: releaseActivity(companyId, unlock, { binding, caller })
              };
            }
            yield* unlock.pipe(Effect.mapError(lifecycleFailure));
          }
        })
      );
    }),
    // Reads the binding a call would be admitted to without admitting, claiming or binding.
    touch: Effect.fn("Fleet.touch")(
      function* (version) {
        const now = yield* Clock.currentTimeMillis;
        if (!options.dev && (yield* store.pausedUntil(version.companyId, version.patchId)) > now)
          return { outcome: "paused" as const };
        const binding = (yield* store.findCompany(version.companyId))[0];
        if (binding?.state !== "active") return { outcome: "unbound" as const };
        return yield* provider.touch(binding.taskId, {
          bindingEpoch: binding.bindingEpoch,
          binding: version
        });
      },
      Effect.catch(() => Effect.succeed({ outcome: "failed" as const }))
    )
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
    bind: Effect.fn("Fleet.bindBundle")(function* (
      bundle: GuestProtocol.Bundle,
      selected,
      options
    ) {
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
          ...settings,
          ...(options?.speculative === true ? { speculative: true } : {})
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
      const binding = (yield* store.findAdmissible(input.companyId))[0];
      if (binding)
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
      const binding = (yield* store.findAdmissible(input.companyId))[0];
      if (binding)
        yield* provider.bind(binding.taskId, {
          companyId: input.companyId,
          bindingEpoch: binding.bindingEpoch,
          ...(yield* supervisorLimits(input.companyId))
        });
      return result;
    })
  };
});
