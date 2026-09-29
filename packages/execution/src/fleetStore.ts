import * as Management from "@patchy/api/management";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export class Binding extends Schema.Class<Binding>("Fleet.Binding")({
  bindingId: Schema.Number,
  bindingEpoch: Schema.Number,
  companyId: Schema.String,
  taskId: Schema.String,
  ownerId: Schema.String,
  state: Schema.Literals(["claiming", "active", "stopping", "stopped"]),
  boundAt: Schema.Number,
  lastActivityAt: Schema.Number,
  idleSince: Schema.NullOr(Schema.Number),
  protectedUntil: Schema.Number,
  spareWaitMs: Schema.Number,
  peakProcesses: Schema.Number,
  releaseCause: Schema.NullOr(Schema.String)
}) {}
export class Task extends Schema.Class<Task>("Fleet.Task")({
  taskId: Schema.String,
  deploymentRevision: Schema.String,
  state: Schema.Literals(["starting", "spare", "bound", "stopping", "stopped"]),
  requestedAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  readyAt: Schema.NullOr(Schema.Number),
  stoppedAt: Schema.NullOr(Schema.Number)
}) {}
export class History extends Schema.Class<History>("Fleet.History")({
  bindingId: Schema.Number,
  bindingEpoch: Schema.Number,
  companyId: Schema.String,
  taskId: Schema.String,
  deploymentRevision: Schema.String,
  boundAt: Schema.Number,
  releasedAt: Schema.NullOr(Schema.Number),
  boundSeconds: Schema.NullOr(Schema.Number),
  spareWaitMs: Schema.Number,
  peakProcesses: Schema.Number,
  releaseCause: Schema.NullOr(Schema.String)
}) {}
class Lease extends Schema.Class<Lease>("Fleet.Lease")({ leaseEpoch: Schema.Number }) {}
class Target extends Schema.Class<Target>("Fleet.Target")({
  wakes: Schema.Number,
  coldStart: Schema.Number,
  spares: Schema.Number
}) {}
class Deployment extends Schema.Class<Deployment>("Fleet.Deployment")({
  revision: Schema.String
}) {}
class Pause extends Schema.Class<Pause>("Fleet.Pause")({ pausedUntil: Schema.Number }) {}
class Flag extends Schema.Class<Flag>("Fleet.Flag")({ acquired: Schema.Boolean }) {}
class CurrentTask extends Schema.Class<CurrentTask>("Fleet.CurrentTask")({
  current: Schema.Boolean
}) {}
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding));
const decodeTasks = Schema.decodeUnknownEffect(Schema.Array(Task));
const decodeLeases = Schema.decodeUnknownEffect(Schema.Array(Lease));
const decodeTargets = Schema.decodeUnknownEffect(Schema.Array(Target));
const decodeDeployments = Schema.decodeUnknownEffect(Schema.Array(Deployment));
const decodePauses = Schema.decodeUnknownEffect(Schema.Array(Pause));
const decodeFlags = Schema.decodeUnknownEffect(Schema.Array(Flag));
const decodeCurrentTasks = Schema.decodeUnknownEffect(Schema.Array(CurrentTask));
const reportJson = Schema.encodeSync(Schema.fromJsonString(Management.ProcessReport));

export const companyLock = (companyId: string) => `execution/company/${companyId}`;
export const bindingLock = (bindingId: number) => `execution/binding/${bindingId}`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bindingColumns =
    sql.literal(`binding_id AS "bindingId", binding_epoch AS "bindingEpoch", company_id AS "companyId",
    task_id AS "taskId", owner_id AS "ownerId", state, bound_at AS "boundAt",
    last_activity_at AS "lastActivityAt", idle_since AS "idleSince", protected_until AS "protectedUntil",
    spare_wait_ms AS "spareWaitMs", peak_processes AS "peakProcesses", release_cause AS "releaseCause"`);
  const taskColumns =
    sql.literal(`task_id AS "taskId", deployment_revision AS "deploymentRevision", state,
    requested_at AS "requestedAt", started_at AS "startedAt", ready_at AS "readyAt", stopped_at AS "stoppedAt"`);
  const bindings = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Binding,
    execute: () => sql`SELECT ${bindingColumns} FROM execution_bindings WHERE state <> 'stopped'`
  });
  const tasks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Task,
    execute: () => sql`SELECT ${taskColumns} FROM execution_tasks WHERE state <> 'stopped'`
  });
  const findCompany = SqlSchema.findAll({
    Request: Schema.String,
    Result: Binding,
    execute: (company) => sql`SELECT ${bindingColumns} FROM execution_bindings
      WHERE company_id = ${company} AND state IN ('claiming', 'active')`
  });
  const findTask = SqlSchema.findAll({
    Request: Schema.String,
    Result: Binding,
    execute: (task) => sql`SELECT ${bindingColumns} FROM execution_bindings WHERE task_id = ${task}`
  });
  const isCurrentTask = (taskId: string) =>
    sql`SELECT EXISTS (
    SELECT 1 FROM execution_tasks WHERE task_id = ${taskId} AND deployment_revision = (
      SELECT revision FROM execution_deployments WHERE NOT retired ORDER BY ordinal DESC LIMIT 1
    )
  ) AS current`.pipe(
      Effect.flatMap(decodeCurrentTasks),
      Effect.map((rows) => rows[0]!.current)
    );
  const history = SqlSchema.findAll({
    Request: Schema.String,
    Result: History,
    execute: (
      company
    ) => sql`SELECT binding_id AS "bindingId", binding_epoch AS "bindingEpoch", company_id AS "companyId",
      task_id AS "taskId", deployment_revision AS "deploymentRevision", bound_at AS "boundAt",
      released_at AS "releasedAt", bound_seconds AS "boundSeconds", spare_wait_ms AS "spareWaitMs",
      peak_processes AS "peakProcesses", release_cause AS "releaseCause"
      FROM execution_binding_history WHERE company_id = ${company} ORDER BY binding_epoch`
  });
  const claim = Effect.fn("FleetStore.claim")(function* (
    company: string,
    owner: string,
    now: number,
    waited: number
  ) {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution/claim/${company}`}, 0))`;
    const existing = yield* findCompany(company);
    if (existing[0]) return existing[0];
    const spare = yield* sql`UPDATE execution_tasks SET state = 'bound' WHERE task_id = (
      SELECT task_id FROM execution_tasks WHERE state = 'spare' AND deployment_revision = (
        SELECT revision FROM execution_deployments WHERE NOT retired ORDER BY ordinal DESC LIMIT 1
      ) ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING ${taskColumns}`.pipe(Effect.flatMap(decodeTasks));
    if (!spare[0]) return undefined;
    const claimed = yield* sql`INSERT INTO execution_bindings
      (company_id, task_id, owner_id, state, bound_at, last_activity_at, spare_wait_ms)
      VALUES (${company}, ${spare[0].taskId}, ${owner}, 'claiming', ${now}, ${now}, ${waited})
      RETURNING ${bindingColumns}`.pipe(Effect.flatMap(decodeBindings));
    const binding = claimed[0]!;
    yield* sql`INSERT INTO execution_binding_history
      (binding_id, binding_epoch, company_id, task_id, deployment_revision, bound_at, spare_wait_ms)
      VALUES (${binding.bindingId}, ${binding.bindingEpoch}, ${company}, ${binding.taskId}, ${spare[0].deploymentRevision}, ${now}, ${waited})`;
    return binding;
  }, sql.withTransaction);
  const activate = (binding: Binding) => sql`UPDATE execution_bindings SET state = 'active'
    WHERE binding_epoch = ${binding.bindingEpoch} AND state = 'claiming'`;
  // The same statement checks ownership and removes the binding from the admission index.
  const fence = (binding: Binding, cause: string) =>
    sql`WITH fenced AS (
    UPDATE execution_bindings SET state = 'stopping', release_cause = ${cause}
    WHERE binding_epoch = ${binding.bindingEpoch} AND owner_id = ${binding.ownerId}
      AND state IN ('claiming', 'active') RETURNING *
  ), task_fence AS (
    UPDATE execution_tasks SET state = 'stopping' WHERE task_id IN (SELECT task_id FROM fenced)
  ) SELECT ${bindingColumns} FROM fenced`.pipe(Effect.flatMap(decodeBindings));
  const adopt = Effect.fn("FleetStore.adopt")(function* (
    binding: Binding,
    owner: string,
    now: number
  ) {
    if (!(yield* exclusive(bindingLock(binding.bindingId)))) return [];
    return yield* sql`UPDATE execution_bindings SET owner_id = ${owner},
      binding_epoch = nextval('execution_binding_epochs'), state = 'claiming'
      WHERE binding_id = ${binding.bindingId} AND binding_epoch = ${binding.bindingEpoch}
        AND owner_id = ${binding.ownerId} AND state = 'active' AND protected_until <= ${now}
        AND EXISTS (SELECT 1 FROM execution_tasks t WHERE t.task_id = execution_bindings.task_id
          AND t.deployment_revision = (
            SELECT revision FROM execution_deployments WHERE NOT retired ORDER BY ordinal DESC LIMIT 1
          ))
      RETURNING ${bindingColumns}`.pipe(Effect.flatMap(decodeBindings));
  }, sql.withTransaction);
  const touch = (company: string, now: number) => sql`UPDATE execution_bindings
    SET last_activity_at = ${now}, idle_since = NULL WHERE company_id = ${company} AND state IN ('claiming', 'active')`;
  const protect = (binding: Binding, until: number, now: number) =>
    sql`UPDATE execution_bindings
    SET protected_until = GREATEST(protected_until, ${until}), last_activity_at = ${now}, idle_since = NULL
    WHERE binding_epoch = ${binding.bindingEpoch} AND state = 'active'
      AND EXISTS (SELECT 1 FROM execution_tasks t WHERE t.task_id = execution_bindings.task_id
        AND t.deployment_revision = (
          SELECT revision FROM execution_deployments WHERE NOT retired ORDER BY ordinal DESC LIMIT 1
        )) RETURNING ${bindingColumns}`.pipe(Effect.flatMap(decodeBindings));
  const exclusive = (key: string) =>
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`.pipe(
      Effect.flatMap(decodeFlags),
      Effect.map((rows) => rows[0]!.acquired)
    );
  const idleFence = Effect.fn("FleetStore.idleFence")(function* (
    binding: Binding,
    now: number,
    idleMs: number
  ) {
    if (
      !(yield* exclusive(companyLock(binding.companyId))) ||
      !(yield* exclusive(bindingLock(binding.bindingId)))
    )
      return [];
    const rows = yield* sql`SELECT ${bindingColumns} FROM execution_bindings
      WHERE binding_epoch = ${binding.bindingEpoch} AND owner_id = ${binding.ownerId}
        AND state = 'active' FOR UPDATE`.pipe(Effect.flatMap(decodeBindings));
    const current = rows[0];
    if (!current || current.protectedUntil > now) return [];
    if (current.idleSince === null) {
      yield* sql`UPDATE execution_bindings SET idle_since = ${now} WHERE binding_epoch = ${current.bindingEpoch}`;
      return [];
    }
    if (now - Math.max(current.idleSince, current.lastActivityAt) < idleMs) return [];
    return yield* fence(current, "idle");
  }, sql.withTransaction);
  const drained = Effect.fn("FleetStore.drained")(function* (binding: Binding, now: number) {
    if (!(yield* exclusive(bindingLock(binding.bindingId)))) return false;
    const rows =
      yield* sql`SELECT ${bindingColumns} FROM execution_bindings WHERE binding_epoch = ${binding.bindingEpoch}`.pipe(
        Effect.flatMap(decodeBindings)
      );
    return rows[0]?.state === "stopping" && rows[0].protectedUntil <= now;
  }, sql.withTransaction);
  const stopped = Effect.fn("FleetStore.stopped")(function* (
    taskId: string,
    stoppedAt: number,
    cause: string
  ) {
    yield* sql`UPDATE execution_tasks SET state = 'stopped', stopped_at = ${stoppedAt} WHERE task_id = ${taskId}`;
    yield* sql`UPDATE execution_bindings SET state = 'stopped', release_cause = COALESCE(release_cause, ${cause})
      WHERE task_id = ${taskId}`;
    yield* sql`UPDATE execution_binding_history h SET released_at = ${stoppedAt},
      bound_seconds = GREATEST(0, ${stoppedAt} - h.bound_at) / 1000,
      release_cause = b.release_cause, peak_processes = b.peak_processes
      FROM execution_bindings b WHERE h.binding_id = b.binding_id AND h.task_id = ${taskId}
        AND h.released_at IS NULL`;
  }, sql.withTransaction);
  const lease = (owner: string, now: number, duration: number) =>
    sql`INSERT INTO execution_housekeeping
    (singleton, owner_id, lease_epoch, expires_at) VALUES (true, ${owner}, 1, ${now + duration})
    ON CONFLICT (singleton) DO UPDATE SET owner_id = EXCLUDED.owner_id,
      lease_epoch = CASE WHEN execution_housekeeping.owner_id = EXCLUDED.owner_id AND execution_housekeeping.expires_at > ${now}
        THEN execution_housekeeping.lease_epoch ELSE execution_housekeeping.lease_epoch + 1 END,
      expires_at = EXCLUDED.expires_at
    WHERE execution_housekeeping.expires_at <= ${now} OR execution_housekeeping.owner_id = ${owner}
    RETURNING lease_epoch AS "leaseEpoch"`.pipe(
      Effect.flatMap(decodeLeases),
      Effect.map((rows) => rows[0])
    );
  const renewLease = (owner: string, epoch: number, now: number, duration: number) =>
    sql`UPDATE execution_housekeeping
    SET expires_at = ${now + duration} WHERE owner_id = ${owner} AND lease_epoch = ${epoch} AND expires_at > ${now}
    RETURNING lease_epoch AS "leaseEpoch"`.pipe(
      Effect.flatMap(decodeLeases),
      Effect.map((rows) => rows.length === 1)
    );
  const registerDeployment = (revision: string) => sql`INSERT INTO execution_deployments(revision)
    VALUES (${revision}) ON CONFLICT DO NOTHING`;
  const currentDeployment =
    sql`SELECT revision FROM execution_deployments WHERE NOT retired ORDER BY ordinal DESC LIMIT 1`.pipe(
      Effect.flatMap(decodeDeployments),
      Effect.map((rows) => rows[0]?.revision)
    );
  const retireDeployment = (revision: string) =>
    sql`UPDATE execution_deployments SET retired = true WHERE revision = ${revision}`;
  const reserve = Effect.fn("FleetStore.reserve")(function* (
    taskId: string,
    revision: string,
    owner: string,
    epoch: number,
    now: number,
    budget: number
  ) {
    const held = yield* sql`SELECT lease_epoch AS "leaseEpoch" FROM execution_housekeeping
      WHERE owner_id = ${owner} AND lease_epoch = ${epoch} AND expires_at > ${now} FOR UPDATE`.pipe(
      Effect.flatMap(decodeLeases)
    );
    if (!held[0]) return false;
    const rows =
      yield* sql`INSERT INTO execution_tasks(task_id, deployment_revision, state, requested_at)
      SELECT ${taskId}, ${revision}, 'starting', ${now}
      WHERE (SELECT count(*) FROM execution_tasks WHERE state <> 'stopped') < ${budget}
        AND EXISTS (SELECT 1 FROM execution_deployments WHERE revision = ${revision} AND NOT retired)
      RETURNING ${taskColumns}`.pipe(Effect.flatMap(decodeTasks));
    return rows.length === 1;
  }, sql.withTransaction);
  const ready = (task: {
    taskId: string;
    startedAt: number;
    readyAt: number;
  }) => sql`UPDATE execution_tasks
    SET started_at = ${task.startedAt}, ready_at = ${task.readyAt}, state = 'spare'
    WHERE task_id = ${task.taskId} AND state = 'starting'`;
  const target = (now: number, window: number, revision: string) =>
    sql`SELECT
    (SELECT count(*)::integer FROM execution_binding_history WHERE bound_at >= ${now - window}) AS wakes,
    COALESCE((SELECT avg(ready_at - started_at) FROM execution_tasks WHERE ready_at IS NOT NULL
      AND requested_at >= ${now - window}), 0)::double precision AS "coldStart",
    (SELECT count(*)::integer FROM execution_tasks WHERE state IN ('starting', 'spare')
      AND deployment_revision = ${revision}) AS spares`.pipe(
      Effect.flatMap(decodeTargets),
      Effect.map((rows) => rows[0]!)
    );
  const pendingEvents = SqlSchema.findAll({
    Request: Schema.Void,
    Result: History,
    execute:
      () => sql`SELECT binding_id AS "bindingId", binding_epoch AS "bindingEpoch", company_id AS "companyId", task_id AS "taskId",
      deployment_revision AS "deploymentRevision", bound_at AS "boundAt", released_at AS "releasedAt",
      bound_seconds AS "boundSeconds", spare_wait_ms AS "spareWaitMs", peak_processes AS "peakProcesses",
      release_cause AS "releaseCause" FROM execution_binding_history WHERE released_at IS NOT NULL AND NOT event_emitted`
  });
  const markEvent = (bindingId: number) =>
    sql`UPDATE execution_binding_history SET event_emitted = true WHERE binding_id = ${bindingId}`;
  // Immutable version numbers, not the served pointer or lifecycle revision:
  // rollback and sharing changes must not clear a pause. Read this on every host.
  const syncPublish = (company: string, patch: string) => sql`INSERT INTO execution_breakers
    (company_id, patch_id, publish_revision, reset_at)
    SELECT ${company}, ${patch}, COALESCE(v.version_number, 0),
      COALESCE(extract(epoch FROM v.created_at)::double precision * 1000, -1)
    FROM (SELECT 1) seed LEFT JOIN LATERAL (
      SELECT version_number, v.created_at FROM patch_versions v JOIN patches p ON p.id = v.patch_id
      WHERE p.company_id = ${company} AND p.id = ${patch} ORDER BY version_number DESC LIMIT 1
    ) v ON true
    ON CONFLICT(company_id, patch_id) DO UPDATE SET publish_revision = EXCLUDED.publish_revision,
      reset_at = EXCLUDED.reset_at, paused_until = 0
    WHERE execution_breakers.publish_revision < EXCLUDED.publish_revision`;
  const pausedUntil = Effect.fn("FleetStore.pausedUntil")(function* (
    company: string,
    patch: string
  ) {
    yield* syncPublish(company, patch);
    return yield* sql`SELECT paused_until AS "pausedUntil"
      FROM execution_breakers WHERE company_id = ${company} AND patch_id = ${patch}`.pipe(
      Effect.flatMap(decodePauses),
      Effect.map((rows) => rows[0]?.pausedUntil ?? 0)
    );
  });
  const report = Effect.fn("FleetStore.report")(function* (
    binding: Binding,
    value: Management.ProcessReport,
    breaker: { kills: number; window: number; pause: number },
    now: number
  ) {
    const { companyId, patchId, versionId } = value.binding;
    const inserted = yield* sql`INSERT INTO execution_processes
      (report_id, task_id, binding_id, binding_epoch, company_id, patch_id, version_id, process_generation,
       started_at, ended_at, cause, cpu_seconds, peak_rss_bytes, calls_served, report)
      VALUES (${value.reportId}, ${binding.taskId}, ${binding.bindingId}, ${value.bindingEpoch}, ${companyId}, ${patchId}, ${versionId},
        ${value.processGeneration}, ${value.startedAt}, ${value.endedAt}, ${value.cause}, ${value.cpuSeconds},
        ${value.peakRssBytes}, ${value.callsServed}, ${reportJson(value)}::jsonb)
      ON CONFLICT DO NOTHING RETURNING report_id`;
    if (inserted.length === 0) return false;
    if (!["deadline", "stall", "memory"].includes(value.cause)) return true;
    yield* syncPublish(companyId, patchId);
    yield* sql`SELECT patch_id FROM execution_breakers WHERE company_id = ${companyId} AND patch_id = ${patchId} FOR UPDATE`;
    yield* sql`INSERT INTO execution_breaker_kills(report_id, company_id, patch_id, killed_at, publish_revision)
      SELECT ${value.reportId}, ${companyId}, ${patchId}, ${value.endedAt}, publish_revision
      FROM execution_breakers WHERE company_id = ${companyId} AND patch_id = ${patchId} AND reset_at < ${value.endedAt}`;
    // Reports may arrive out of order after an acknowledgement is lost.
    yield* sql`UPDATE execution_breakers b SET paused_until = GREATEST(b.paused_until, observed.last_kill + ${breaker.pause})
      FROM (SELECT max(k.killed_at) AS last_kill FROM execution_breaker_kills k JOIN execution_breakers b
        ON b.company_id = k.company_id AND b.patch_id = k.patch_id AND b.publish_revision = k.publish_revision
        WHERE k.company_id = ${companyId} AND k.patch_id = ${patchId}) AS observed
      WHERE b.company_id = ${companyId} AND b.patch_id = ${patchId}
        AND observed.last_kill + ${breaker.pause} > ${now}
        AND (SELECT count(*) FROM execution_breaker_kills k WHERE k.company_id = ${companyId} AND k.patch_id = ${patchId}
          AND k.publish_revision = b.publish_revision AND k.killed_at > observed.last_kill - ${breaker.window}
          AND k.killed_at <= observed.last_kill) >= ${breaker.kills}`;
    return true;
  }, sql.withTransaction);
  const peak = (bindingId: number, processes: number) => sql`UPDATE execution_bindings
    SET peak_processes = GREATEST(peak_processes, ${processes}) WHERE binding_id = ${bindingId}`;
  return {
    sql,
    bindings,
    tasks,
    findCompany,
    findTask,
    isCurrentTask,
    history,
    claim,
    activate,
    fence,
    adopt,
    touch,
    protect,
    idleFence,
    drained,
    stopped,
    lease,
    renewLease,
    registerDeployment,
    currentDeployment,
    retireDeployment,
    reserve,
    ready,
    target,
    pendingEvents,
    markEvent,
    pausedUntil,
    report,
    peak
  };
});
