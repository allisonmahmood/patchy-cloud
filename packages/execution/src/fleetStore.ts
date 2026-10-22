import * as Management from "@patchy/api/management";
import type { Caller } from "@patchy/runtime/execution-lifecycle";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class Binding extends Schema.Class<Binding>("Fleet.Binding")({
  bindingId: Schema.Number,
  bindingEpoch: Schema.Number,
  companyId: Schema.String,
  taskId: Schema.String,
  ownerId: Schema.String,
  state: Schema.Literals(["claiming", "active", "stopping", "stopped"]),
  boundAt: Schema.Number,
  /** The documents' clock: a page's last call or document letting go, 0 for none yet. */
  lastActivityAt: Schema.Number,
  /**
   * When a housekeeping pass first found no document holding the task since one last did: the
   * documents' clock runs from no earlier than this, so a holder that went without letting go
   * still leaves the whole window.
   */
  idleSince: Schema.NullOr(Schema.Number),
  /** The agent idle clock: an agent's last call settling, 0 for none. */
  agentActivityAt: Schema.Number,
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
  releaseCause: Schema.NullOr(Schema.String),
  /** No document held it and no page's work ran on it; null before release and before agents. */
  agentOnly: Schema.NullOr(Schema.Boolean)
}) {}
class Lease extends Schema.Class<Lease>("Fleet.Lease")({ leaseEpoch: Schema.Number }) {}
class Target extends Schema.Class<Target>("Fleet.Target")({
  wakes: Schema.Number,
  coldStart: Schema.Number,
  spares: Schema.Number
}) {}
class Rollout extends Schema.Class<Rollout>("Fleet.Rollout")({
  currentRevision: Schema.NullOr(Schema.String),
  stagedRevision: Schema.NullOr(Schema.String)
}) {}
class Pause extends Schema.Class<Pause>("Fleet.Pause")({ pausedUntil: Schema.Number }) {}
class Flag extends Schema.Class<Flag>("Fleet.Flag")({ acquired: Schema.Boolean }) {}
class AdmissibleTask extends Schema.Class<AdmissibleTask>("Fleet.AdmissibleTask")({
  admissible: Schema.Boolean
}) {}
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding));
const decodeTasks = Schema.decodeUnknownEffect(Schema.Array(Task));
const decodeLeases = Schema.decodeUnknownEffect(Schema.Array(Lease));
const decodeTargets = Schema.decodeUnknownEffect(Schema.Array(Target));
const decodeRollouts = Schema.decodeUnknownEffect(Schema.Array(Rollout));
const decodePauses = Schema.decodeUnknownEffect(Schema.Array(Pause));
const decodeFlags = Schema.decodeUnknownEffect(Schema.Array(Flag));
const decodeAdmissibleTasks = Schema.decodeUnknownEffect(Schema.Array(AdmissibleTask));
const reportJson = Schema.encodeSync(Schema.fromJsonString(Management.ProcessReport));

/** A binding's two clocks: the documents' with where its window starts, and the agents'. */
export type Clocks = Pick<Binding, "lastActivityAt" | "idleSince" | "agentActivityAt">;
/** The clocks a claim starts: its caller's runs from `now`, the other has not run. */
export const clocksOf = (caller: Caller, now: number): Clocks =>
  caller === "agent"
    ? { lastActivityAt: 0, idleSince: null, agentActivityAt: now }
    : { lastActivityAt: now, idleSince: null, agentActivityAt: 0 };

export const companyLock = (companyId: string) => `execution/company/${companyId}`;
export const bindingLock = (bindingId: number) => `execution/binding/${bindingId}`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bindingColumns =
    sql.literal(`binding_id AS "bindingId", binding_epoch AS "bindingEpoch", company_id AS "companyId",
    task_id AS "taskId", owner_id AS "ownerId", state, bound_at AS "boundAt",
    last_activity_at AS "lastActivityAt", idle_since AS "idleSince", agent_activity_at AS "agentActivityAt",
    protected_until AS "protectedUntil",
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
  // A bound task on a deployment that is not retired can take admissions. The warm read,
  // `protect` and `adopt` share this check, so they agree on which tasks can.
  const admissibleTask = sql.literal(`EXISTS (SELECT 1 FROM execution_tasks t
    JOIN execution_deployments d ON d.revision = t.deployment_revision
    WHERE t.task_id = execution_bindings.task_id AND t.state = 'bound' AND NOT d.retired)`);
  // The warm path's one read: the company's active binding, while its task can take admissions.
  const findAdmissible = SqlSchema.findAll({
    Request: Schema.String,
    Result: Binding,
    execute: (company) => sql`SELECT ${bindingColumns} FROM execution_bindings
      WHERE company_id = ${company} AND state = 'active' AND ${admissibleTask}`
  });
  const findTask = SqlSchema.findAll({
    Request: Schema.String,
    Result: Binding,
    execute: (task) => sql`SELECT ${bindingColumns} FROM execution_bindings WHERE task_id = ${task}`
  });
  const isAdmissibleTask = (taskId: string) =>
    sql`SELECT EXISTS (
    SELECT 1 FROM execution_tasks t JOIN execution_deployments d ON d.revision = t.deployment_revision
    WHERE t.task_id = ${taskId} AND t.state = 'bound' AND NOT d.retired
  ) AS admissible`.pipe(
      Effect.flatMap(decodeAdmissibleTasks),
      Effect.map((rows) => rows[0]!.admissible)
    );
  const history = SqlSchema.findAll({
    Request: Schema.String,
    Result: History,
    execute: (
      company
    ) => sql`SELECT binding_id AS "bindingId", binding_epoch AS "bindingEpoch", company_id AS "companyId",
      task_id AS "taskId", deployment_revision AS "deploymentRevision", bound_at AS "boundAt",
      released_at AS "releasedAt", bound_seconds AS "boundSeconds", spare_wait_ms AS "spareWaitMs",
      peak_processes AS "peakProcesses", release_cause AS "releaseCause", agent_only AS "agentOnly"
      FROM execution_binding_history WHERE company_id = ${company} ORDER BY binding_epoch`
  });
  /** Binds a spare to `company` with its two clocks as given, or answers its live binding. */
  const claim = Effect.fn("FleetStore.claim")(function* (
    company: string,
    owner: string,
    now: number,
    waited: number,
    clocks: Clocks
  ) {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution/claim/${company}`}, 0))`;
    const existing = yield* findCompany(company);
    if (existing[0]) return existing[0];
    const spare = yield* sql`UPDATE execution_tasks SET state = 'bound' WHERE task_id = (
      SELECT task_id FROM execution_tasks WHERE state = 'spare' AND deployment_revision = (
        SELECT current_revision FROM execution_rollout WHERE singleton
      ) ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING ${taskColumns}`.pipe(Effect.flatMap(decodeTasks));
    if (!spare[0]) return undefined;
    const claimed = yield* sql`INSERT INTO execution_bindings
      (company_id, task_id, owner_id, state, bound_at, last_activity_at, idle_since, agent_activity_at, spare_wait_ms)
      VALUES (${company}, ${spare[0].taskId}, ${owner}, 'claiming', ${now}, ${clocks.lastActivityAt},
        ${clocks.idleSince}, ${clocks.agentActivityAt}, ${waited})
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
  const replaceDeploymentBinding = Effect.fn("FleetStore.replaceDeploymentBinding")(function* (
    owner: string,
    now: number
  ) {
    const deployment = yield* sql`SELECT current_revision FROM execution_rollout
      WHERE singleton FOR SHARE`;
    const revision = deployment[0]?.current_revision;
    if (typeof revision !== "string") return undefined;
    // One unfinished replacement at a time keeps draining calls within the fleet budget.
    const pending = yield* sql`SELECT binding_id FROM execution_bindings
      WHERE state = 'stopping' AND release_cause = 'deployment' LIMIT 1`;
    if (pending.length > 0) return undefined;
    const candidates = yield* sql`SELECT b.company_id FROM execution_bindings b
      JOIN execution_tasks t ON t.task_id = b.task_id
      WHERE b.state IN ('active', 'claiming') AND t.deployment_revision <> ${revision}
      ORDER BY b.binding_id LIMIT 1`;
    const company = candidates[0]?.company_id;
    if (typeof company !== "string") return undefined;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution/claim/${company}`}, 0))`;
    const previous = (yield* findCompany(company))[0];
    if (!previous) return undefined;
    const spare = yield* sql`SELECT task_id FROM execution_tasks
      WHERE state = 'spare' AND deployment_revision = ${revision}
      ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (spare.length === 0) return undefined;
    const fenced = yield* fence(previous, "deployment");
    if (!fenced[0]) return undefined;
    // The replacement keeps both clocks running from where its predecessor's stood.
    const replacement = yield* claim(company, owner, now, 0, fenced[0]);
    return replacement ? { previous: fenced[0], replacement } : undefined;
  }, sql.withTransaction);
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
        AND ${admissibleTask}
      RETURNING ${bindingColumns}`.pipe(Effect.flatMap(decodeBindings));
  }, sql.withTransaction);
  // The clock admitted work runs: the documents' for a page's, the agent idle clock for an agent's.
  const clockOf = (caller: Caller) =>
    sql.literal(caller === "agent" ? "agent_activity_at" : "last_activity_at");
  // Runs the caller's clock from `now` on the company's admission binding: a document's touch or
  // a call settling, its own binding or the one that replaced it meanwhile. A clock only moves
  // forward, so a settlement that lands late never shortens a later one's window. A replacement
  // that committed while the update waited on its predecessor's row is outside the update's
  // snapshot, so an update that found no live binding runs once more.
  const touch = Effect.fn("FleetStore.touch")(function* (
    company: string,
    now: number,
    caller: Caller = "page"
  ) {
    const run = sql`UPDATE execution_bindings
      SET ${clockOf(caller)} = GREATEST(${clockOf(caller)}, ${now})
      WHERE company_id = ${company} AND state IN ('claiming', 'active') RETURNING binding_id`;
    if ((yield* run).length === 0) yield* run;
  });
  const protect = (binding: Binding, until: number, now: number, caller: Caller) =>
    sql`UPDATE execution_bindings
    SET protected_until = GREATEST(protected_until, ${until}),
      ${clockOf(caller)} = GREATEST(${clockOf(caller)}, ${now})
    WHERE binding_epoch = ${binding.bindingEpoch} AND state = 'active' AND ${admissibleTask}
    RETURNING ${bindingColumns}`.pipe(Effect.flatMap(decodeBindings));
  // Once no caller holds the call's binding, clears its crash protection, draining or not. The
  // exclusive try-lock lasts until the statement commits, so a new holder waits and then
  // protects again.
  const release = (binding: Binding) => sql`UPDATE execution_bindings SET protected_until = 0
    WHERE binding_id = ${binding.bindingId}
      AND pg_try_advisory_xact_lock(hashtextextended(${bindingLock(binding.bindingId)}, 0))`;
  const exclusive = (key: string) =>
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`.pipe(
      Effect.flatMap(decodeFlags),
      Effect.map((rows) => rows[0]!.acquired)
    );
  /**
   * Releases a binding once no document holds it, no admitted work is in flight on it or on a
   * binding of the company still draining, and both clocks have run out: `idleMs` from the
   * documents' last activity, `agentIdleMs` from an agent's last call settling. Work in flight
   * moves neither clock until it settles.
   */
  const idleFence = Effect.fn("FleetStore.idleFence")(function* (
    binding: Binding,
    now: number,
    idle: { readonly idleMs: number; readonly agentIdleMs: number }
  ) {
    if (!(yield* exclusive(companyLock(binding.companyId)))) {
      yield* sql`UPDATE execution_bindings SET idle_since = NULL
        WHERE binding_epoch = ${binding.bindingEpoch} AND state = 'active'`;
      return [];
    }
    // No document holds it, so the documents' window, once a document or a page's work has run
    // their clock, starts no later than now, whatever work is in flight.
    yield* sql`UPDATE execution_bindings SET idle_since = ${now}
      WHERE binding_epoch = ${binding.bindingEpoch} AND state = 'active'
        AND idle_since IS NULL AND last_activity_at > 0`;
    if (!(yield* exclusive(bindingLock(binding.bindingId)))) return [];
    // Work on a binding this one replaced settles onto this one's clocks.
    const drained = yield* sql`SELECT COALESCE(bool_and(protected_until <= ${now}
        AND pg_try_advisory_xact_lock(hashtextextended('execution/binding/' || binding_id, 0))), true)
        AS acquired
      FROM execution_bindings WHERE company_id = ${binding.companyId} AND state = 'stopping'`.pipe(
      Effect.flatMap(decodeFlags),
      Effect.map((rows) => rows[0]!.acquired)
    );
    if (!drained) return [];
    const rows = yield* sql`SELECT ${bindingColumns} FROM execution_bindings
      WHERE binding_epoch = ${binding.bindingEpoch} AND owner_id = ${binding.ownerId}
        AND state = 'active' FOR UPDATE`.pipe(Effect.flatMap(decodeBindings));
    const current = rows[0];
    if (!current || current.protectedUntil > now) return [];
    // The documents' window, from no earlier than the first pass to find no document holding
    // the task. Agents never move it.
    if (
      current.lastActivityAt > 0 &&
      now - Math.max(current.idleSince ?? now, current.lastActivityAt) < idle.idleMs
    )
      return [];
    if (now - current.agentActivityAt < idle.agentIdleMs) return [];
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
      release_cause = b.release_cause, peak_processes = b.peak_processes,
      agent_only = (b.last_activity_at = 0)
      FROM execution_bindings b WHERE h.binding_id = b.binding_id AND h.task_id = ${taskId}
        AND h.released_at IS NULL`;
  }, sql.withTransaction);
  const recordOrphan = Effect.fn("FleetStore.recordOrphan")(function* (
    task: { taskId: string; deploymentRevision: string; startedAt: number },
    now: number
  ) {
    yield* sql`INSERT INTO execution_deployments(revision, retired)
      VALUES (${task.deploymentRevision}, true) ON CONFLICT DO NOTHING`;
    // The insert can race a reservation made after the inventory snapshot.
    const rows = yield* sql`INSERT INTO execution_tasks
      (task_id, deployment_revision, state, requested_at, started_at)
      VALUES (${task.taskId}, ${task.deploymentRevision}, 'stopping', ${now}, ${task.startedAt})
      ON CONFLICT (task_id) DO UPDATE SET state = 'stopping', stopped_at = NULL
        WHERE execution_tasks.state = 'stopped'
      RETURNING task_id`;
    return rows.length === 1;
  }, sql.withTransaction);
  const lease = (owner: string, revision: string, now: number, duration: number) =>
    sql`INSERT INTO execution_housekeeping
    (singleton, owner_id, lease_epoch, expires_at) SELECT true, ${owner}, 1, ${now + duration}
    WHERE EXISTS (
      SELECT 1 FROM execution_rollout WHERE COALESCE(staged_revision, current_revision) = ${revision}
    )
    ON CONFLICT (singleton) DO UPDATE SET owner_id = EXCLUDED.owner_id,
      lease_epoch = CASE WHEN execution_housekeeping.owner_id = EXCLUDED.owner_id AND execution_housekeeping.expires_at > ${now}
        THEN execution_housekeeping.lease_epoch ELSE execution_housekeeping.lease_epoch + 1 END,
      expires_at = EXCLUDED.expires_at
    WHERE execution_housekeeping.expires_at <= ${now} OR execution_housekeeping.owner_id = ${owner}
    RETURNING lease_epoch AS "leaseEpoch"`.pipe(
      Effect.flatMap(decodeLeases),
      Effect.map((rows) => rows[0])
    );
  // Concurrent guards' renewals can land out of order; a late one never shortens the lease.
  const renewLease = (
    owner: string,
    revision: string,
    epoch: number,
    now: number,
    duration: number
  ) =>
    sql`UPDATE execution_housekeeping
    SET expires_at = GREATEST(expires_at, ${now + duration}) WHERE owner_id = ${owner} AND lease_epoch = ${epoch} AND expires_at > ${now}
      AND EXISTS (
        SELECT 1 FROM execution_rollout WHERE COALESCE(staged_revision, current_revision) = ${revision}
      )
    RETURNING lease_epoch AS "leaseEpoch"`.pipe(
      Effect.flatMap(decodeLeases),
      Effect.map((rows) => rows.length === 1)
    );
  const registerDeployment = Effect.fn("FleetStore.registerDeployment")(function* (
    revision: string
  ) {
    yield* sql`INSERT INTO execution_deployments(revision) VALUES (${revision}) ON CONFLICT DO NOTHING`;
    yield* sql`UPDATE execution_rollout SET staged_revision = ${revision}
      WHERE singleton AND current_revision IS NULL AND staged_revision IS NULL
        AND EXISTS (SELECT 1 FROM execution_deployments WHERE revision = ${revision} AND NOT retired)`;
  }, sql.withTransaction);
  const rollout =
    sql`SELECT current_revision AS "currentRevision", staged_revision AS "stagedRevision"
    FROM execution_rollout WHERE singleton`.pipe(
      Effect.flatMap(decodeRollouts),
      Effect.map((rows) => rows[0]!)
    );
  const stageDeployment = Effect.fn("FleetStore.stageDeployment")(function* (revision: string) {
    yield* sql`SELECT singleton FROM execution_rollout WHERE singleton FOR UPDATE`;
    const registered = yield* sql`UPDATE execution_deployments SET retired = false
      WHERE revision = ${revision} RETURNING revision`;
    if (registered.length === 0) return false;
    yield* sql`UPDATE execution_rollout SET staged_revision = ${revision} WHERE singleton`;
    return true;
  }, sql.withTransaction);
  const promoteDeployment = Effect.fn("FleetStore.promoteDeployment")(function* (
    revision: string,
    minimumSpares: number,
    bootstrapOnly = false
  ) {
    yield* sql`SELECT singleton FROM execution_rollout WHERE singleton FOR UPDATE`;
    return yield* sql`UPDATE execution_rollout SET current_revision = ${revision}, staged_revision = NULL
      WHERE singleton AND staged_revision = ${revision}
        AND (${!bootstrapOnly} OR current_revision IS NULL)
        AND EXISTS (SELECT 1 FROM execution_deployments WHERE revision = ${revision} AND NOT retired)
        AND (SELECT count(*) FROM execution_tasks
          WHERE deployment_revision = ${revision} AND state = 'spare') >= ${minimumSpares}
      RETURNING singleton`.pipe(Effect.map((rows) => rows.length === 1));
  }, sql.withTransaction);
  const retireDeployment = Effect.fn("FleetStore.retireDeployment")(function* (revision: string) {
    yield* sql`UPDATE execution_rollout SET
      current_revision = CASE WHEN current_revision = ${revision} THEN NULL ELSE current_revision END,
      staged_revision = CASE WHEN staged_revision = ${revision} THEN NULL ELSE staged_revision END
      WHERE singleton`;
    yield* sql`UPDATE execution_deployments SET retired = true WHERE revision = ${revision}`;
  }, sql.withTransaction);
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
        AND EXISTS (SELECT 1 FROM execution_rollout WHERE singleton
          AND (current_revision = ${revision} OR staged_revision = ${revision}))
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
    COALESCE((SELECT avg(ready_at - requested_at) FROM execution_tasks WHERE ready_at IS NOT NULL
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
      release_cause AS "releaseCause", agent_only AS "agentOnly"
      FROM execution_binding_history WHERE released_at IS NOT NULL AND NOT event_emitted`
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
  // The read is its own statement so it sees a trip or publish that committed while the
  // upsert waited on the row; one statement would read the row as it stood before that wait.
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
    findAdmissible,
    findTask,
    isAdmissibleTask,
    history,
    claim,
    activate,
    fence,
    replaceDeploymentBinding,
    adopt,
    touch,
    protect,
    release,
    idleFence,
    drained,
    stopped,
    recordOrphan,
    lease,
    renewLease,
    registerDeployment,
    rollout,
    stageDeployment,
    promoteDeployment,
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
