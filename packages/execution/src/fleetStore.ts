import * as Management from "@patchy/api/management";
import type { Caller } from "@patchy/runtime/execution-lifecycle";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as ActiveMembers from "./ActiveMembers.js";
import * as TaskProvider from "./TaskProvider.js";

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
/**
 * A binding with its task's CPU units: the idle scan picks the tail by them, and an admitted
 * call's event records them.
 */
export class SizedBinding extends Schema.Class<SizedBinding>("Fleet.SizedBinding")({
  ...Binding.fields,
  cpu: Schema.Number
}) {}
export class Task extends Schema.Class<Task>("Fleet.Task")({
  taskId: Schema.String,
  deploymentRevision: Schema.String,
  state: Schema.Literals(["starting", "spare", "bound", "stopping", "stopped"]),
  requestedAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  readyAt: Schema.NullOr(Schema.Number),
  stoppedAt: Schema.NullOr(Schema.Number),
  /**
   * The size asked for while the task starts, which a retried launch asks for again; once it is
   * ready, or fenced at readiness, the size the provider observed. A bound task's size never
   * changes.
   */
  cpu: Schema.Number,
  memory: Schema.Number,
  /**
   * Certainly nothing was ever launched for it: this host's code reserved it as a small box, and
   * every launch attempt since, if any, was refused outright. Unknown reads as false: a full
   * reservation, a row an older host inserted, or one whose task was seen running.
   */
  launchedNothing: Schema.Boolean
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
  /**
   * No document held it and no page's work ran on it, only agents' calls; null before release,
   * before agents, and for a prewarm's task nobody used.
   */
  agentOnly: Schema.NullOr(Schema.Boolean),
  /** The CPU units of the box it was bound to. */
  cpu: Schema.Number
}) {}
class Lease extends Schema.Class<Lease>("Fleet.Lease")({ leaseEpoch: Schema.Number }) {}
class Target extends Schema.Class<Target>("Fleet.Target")({
  fullWakes: Schema.Number,
  smallWakes: Schema.Number,
  fullColdStart: Schema.Number,
  smallColdStart: Schema.Number,
  fullSpares: Schema.Number,
  smallSpares: Schema.Number,
  fullReadySpares: Schema.Number,
  smallReadySpares: Schema.Number,
  fullWaiting: Schema.Number,
  smallWaiting: Schema.Number
}) {}
class Rollout extends Schema.Class<Rollout>("Fleet.Rollout")({
  currentRevision: Schema.NullOr(Schema.String),
  stagedRevision: Schema.NullOr(Schema.String),
  /** One-member companies claim small boxes and small spares are kept; off by default. */
  smallBoxes: Schema.Boolean
}) {}
class Pause extends Schema.Class<Pause>("Fleet.Pause")({ pausedUntil: Schema.Number }) {}
class Flag extends Schema.Class<Flag>("Fleet.Flag")({ acquired: Schema.Boolean }) {}
class Cpu extends Schema.Class<Cpu>("Fleet.Cpu")({ cpu: Schema.Number }) {}
/** What a claim's one statement found: the CPU units it needs, and the spare it bound if any. */
class ClaimRow extends Schema.Class<ClaimRow>("Fleet.ClaimRow")({
  needed: Schema.Number,
  taskId: Schema.NullOr(Schema.String),
  deploymentRevision: Schema.NullOr(Schema.String)
}) {}
class ReserveRow extends Schema.Class<ReserveRow>("Fleet.ReserveRow")({
  reserved: Schema.Boolean,
  listed: Schema.Boolean,
  spares: Schema.Number
}) {}
class AdmissibleTask extends Schema.Class<AdmissibleTask>("Fleet.AdmissibleTask")({
  admissible: Schema.Boolean
}) {}
/**
 * What `small-boxes status` reads in one snapshot: the switch, ready small tasks not stopped by
 * state, and every row never admitted at readiness that is not stopped and asked for a small box
 * or was observed running at one.
 */
export class SmallBoxesStatus extends Schema.Class<SmallBoxesStatus>("Fleet.SmallBoxesStatus")({
  smallBoxes: Schema.Boolean,
  small: Schema.Record(Schema.String, Schema.Number),
  unverified: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      state: Schema.String,
      cpu: Schema.Number,
      launchedNothing: Schema.Boolean
    })
  )
}) {}
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding));
const decodeSized = Schema.decodeUnknownEffect(Schema.Array(SizedBinding));
const decodeTasks = Schema.decodeUnknownEffect(Schema.Array(Task));
const decodeLeases = Schema.decodeUnknownEffect(Schema.Array(Lease));
const decodeTargets = Schema.decodeUnknownEffect(Schema.Array(Target));
const decodeRollouts = Schema.decodeUnknownEffect(Schema.Array(Rollout));
const decodePauses = Schema.decodeUnknownEffect(Schema.Array(Pause));
const decodeFlags = Schema.decodeUnknownEffect(Schema.Array(Flag));
const decodeCpus = Schema.decodeUnknownEffect(Schema.Array(Cpu));
const decodeClaimRows = Schema.decodeUnknownEffect(Schema.Array(ClaimRow));
const decodeReserveRows = Schema.decodeUnknownEffect(Schema.Array(ReserveRow));
const decodeAdmissibleTasks = Schema.decodeUnknownEffect(Schema.Array(AdmissibleTask));
const decodeStatus = Schema.decodeUnknownEffect(Schema.Array(SmallBoxesStatus));
const reportJson = Schema.encodeSync(Schema.fromJsonString(Management.ProcessReport));
const { full, small } = TaskProvider;

/** What one size's pool looks like for a revision, for its target and trim. */
export interface Demand {
  readonly wakes: number;
  readonly coldStart: number;
  readonly spares: number;
  readonly readySpares: number;
  readonly waiting: number;
}

/** A binding's two clocks: the documents' with where its window starts, and the agents'. */
export type Clocks = Pick<Binding, "lastActivityAt" | "idleSince" | "agentActivityAt">;
/** The clocks a claim starts: its caller's runs from `now`, the other has not run. */
export const clocksOf = (caller: Caller, now: number): Clocks =>
  caller === "agent"
    ? { lastActivityAt: 0, idleSince: null, agentActivityAt: now }
    : caller === "page"
      ? { lastActivityAt: now, idleSince: null, agentActivityAt: 0 }
      : { lastActivityAt: 0, idleSince: null, agentActivityAt: 0 };
/**
 * What a claim may take: any ready spare its size allows, or for a prewarm only one of exactly
 * its size beyond `reserve` ready ones of that size, while `budget` vCPU has room to replace it.
 */
export interface Capacity {
  readonly reserve: number;
  readonly budget: number;
}

/**
 * What a spare reservation came to, including the revision's live spares of that size when at
 * budget. `small_off`: a small one was refused because small boxes are off or the revision is not
 * current.
 */
export type ReserveResult =
  | { readonly outcome: "reserved" }
  | { readonly outcome: "lease_lost" }
  | { readonly outcome: "retired" }
  | { readonly outcome: "small_off" }
  | { readonly outcome: "budget"; readonly spares: number };

/** What a launched task's readiness came to: a spare, a task to drain, or a row no longer starting. */
export type Admission = "spare" | "drain" | "gone";

export const companyLock = (companyId: string) => `execution/company/${companyId}`;
/** Held while a prewarm holds the company's task: it defers release without moving a clock. */
export const prewarmLock = (companyId: string) => `execution/prewarm/${companyId}`;
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
    requested_at AS "requestedAt", started_at AS "startedAt", ready_at AS "readyAt", stopped_at AS "stoppedAt",
    cpu, memory, COALESCE(unrefused_launches = 0, false) AS "launchedNothing"`);
  // A binding's task's CPU units, by its primary key, beside a row of execution_bindings.
  const boundCpu = sql.literal(`(SELECT t.cpu FROM execution_tasks t
    WHERE t.task_id = execution_bindings.task_id) AS cpu`);
  // The CPU units every live task is charged: its own once its size was verified at readiness,
  // a full box's while it was never verified, whether still starting or already stopping.
  const liveCpu = sql.literal(`(SELECT COALESCE(sum(CASE WHEN ready_at IS NULL THEN ${full.cpu}
    ELSE cpu END), 0) FROM execution_tasks WHERE state <> 'stopped')`);
  // Room for one more reservation within `budget` vCPU: the new starting row is charged as full.
  const room = (budget: number) => sql`${liveCpu} + ${full.cpu} <= ${budget * full.cpu}`;
  const bindings = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SizedBinding,
    execute: () =>
      sql`SELECT ${bindingColumns}, ${boundCpu} FROM execution_bindings WHERE state <> 'stopped'`
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
  // History with the CPU units of the box each binding was bound to; task rows are never deleted.
  const historyColumns =
    sql.literal(`h.binding_id AS "bindingId", h.binding_epoch AS "bindingEpoch", h.company_id AS "companyId",
      h.task_id AS "taskId", h.deployment_revision AS "deploymentRevision", h.bound_at AS "boundAt",
      h.released_at AS "releasedAt", h.bound_seconds AS "boundSeconds", h.spare_wait_ms AS "spareWaitMs",
      h.peak_processes AS "peakProcesses", h.release_cause AS "releaseCause", h.agent_only AS "agentOnly",
      t.cpu`);
  const history = SqlSchema.findAll({
    Request: Schema.String,
    Result: History,
    execute: (company) => sql`SELECT ${historyColumns}
      FROM execution_binding_history h JOIN execution_tasks t ON t.task_id = h.task_id
      WHERE h.company_id = ${company} ORDER BY h.binding_epoch`
  });
  const claimLock = (company: string) => `execution/claim/${company}`;
  const lockClaim = (company: string) =>
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${claimLock(company)}, 0))`;
  const rolloutColumns = sql.literal(`current_revision AS "currentRevision",
    staged_revision AS "stagedRevision", small_boxes AS "smallBoxes"`);
  const currentRollout = sql`SELECT ${rolloutColumns} FROM execution_rollout WHERE singleton`;
  /**
   * The size a replacement for `company` needs: small while small boxes are on and the company
   * has exactly one active member, full otherwise. Read under the company's claim lock.
   */
  const neededSize = Effect.fn("FleetStore.neededSize")(function* (
    company: string,
    smallBoxes: boolean
  ) {
    if (!smallBoxes) return full;
    const members = yield* ActiveMembers.ActiveMembers;
    return (yield* members.count(company)) === 1 ? small : full;
  });
  // Binds the locked spare `spare` to `company` and records its history, clearing any wait.
  const bindSpare = Effect.fn("FleetStore.bindSpare")(function* (
    company: string,
    owner: string,
    now: number,
    waited: number,
    clocks: Clocks,
    spare: Pick<Task, "taskId" | "deploymentRevision">
  ) {
    const claimed = yield* sql`INSERT INTO execution_bindings
      (company_id, task_id, owner_id, state, bound_at, last_activity_at, idle_since, agent_activity_at, spare_wait_ms)
      VALUES (${company}, ${spare.taskId}, ${owner}, 'claiming', ${now}, ${clocks.lastActivityAt},
        ${clocks.idleSince}, ${clocks.agentActivityAt}, ${waited})
      RETURNING ${bindingColumns}`.pipe(Effect.flatMap(decodeBindings));
    const binding = claimed[0]!;
    yield* sql`INSERT INTO execution_binding_history
      (binding_id, binding_epoch, company_id, task_id, deployment_revision, bound_at, spare_wait_ms)
      VALUES (${binding.bindingId}, ${binding.bindingEpoch}, ${company}, ${binding.taskId}, ${spare.deploymentRevision}, ${now}, ${waited})`;
    yield* sql`DELETE FROM execution_pool_waits WHERE company_id = ${company}`;
    return binding;
  });
  /**
   * Binds a spare to `company` with its two clocks as given, or answers its live binding, clearing
   * any recorded pool wait for `company`. Under the company's claim lock it counts the company's
   * active members, then one statement reads the switch and the current revision, sizes the claim
   * and picks and binds the spare, so all three come from that statement's snapshot and the claim
   * takes no lock on the rollout row; a promotion or flip that commits after it changes the next
   * claim. A full claim takes only a full spare; a small one takes a small spare when one is ready
   * and a full one otherwise. With `capacity`, it takes a spare of exactly the company's size and
   * only as that allows. On an empty-pool miss with `waitUntil`, it records or extends the
   * company's wait, with the size that statement found it needs, inside the same per-company claim
   * transaction so concurrent claims and misses never race. The spares it counts stay locked until
   * it commits, so concurrent claims never count the same one.
   */
  const claim = Effect.fn("FleetStore.claim")(function* (
    company: string,
    owner: string,
    now: number,
    waited: number,
    clocks: Clocks,
    capacity?: Capacity,
    waitUntil?: number
  ) {
    yield* lockClaim(company);
    const existing = yield* findCompany(company);
    if (existing[0]) {
      yield* sql`DELETE FROM execution_pool_waits WHERE company_id = ${company}`;
      return existing[0];
    }
    const members = yield* (yield* ActiveMembers.ActiveMembers).count(company);
    const reserve = capacity?.reserve ?? 0;
    const sized = sql.literal(capacity === undefined ? ">=" : "=");
    const roomy = capacity === undefined ? sql.literal("true") : room(capacity.budget);
    const rows = yield* sql`WITH rollout AS (
        SELECT current_revision, CASE WHEN small_boxes AND ${members} = 1
          THEN ${small.cpu}::integer ELSE ${full.cpu}::integer END AS needed
        FROM execution_rollout WHERE singleton
      ), ready AS (
        SELECT task_id, cpu, requested_at FROM execution_tasks
        WHERE state = 'spare' AND deployment_revision = (SELECT current_revision FROM rollout)
          AND cpu ${sized} (SELECT needed FROM rollout)
        ORDER BY cpu, requested_at FOR UPDATE SKIP LOCKED LIMIT ${reserve + 1}
      ), bound AS (
        UPDATE execution_tasks SET state = 'bound'
        WHERE task_id = (SELECT task_id FROM ready ORDER BY cpu, requested_at LIMIT 1)
          AND (SELECT count(*) FROM ready) > ${reserve} AND ${roomy}
        RETURNING task_id, deployment_revision
      )
      SELECT rollout.needed, bound.task_id AS "taskId",
        bound.deployment_revision AS "deploymentRevision"
      FROM rollout LEFT JOIN bound ON true`.pipe(Effect.flatMap(decodeClaimRows));
    const row = rows[0];
    if (!row || row.taskId === null || row.deploymentRevision === null) {
      // The size is written even when `until` stands, so a wait counts toward what it needs now.
      if (waitUntil !== undefined)
        yield* sql`INSERT INTO execution_pool_waits (company_id, until, cpu)
          VALUES (${company}, ${waitUntil}, ${row?.needed ?? full.cpu})
          ON CONFLICT (company_id) DO UPDATE
          SET until = GREATEST(execution_pool_waits.until, EXCLUDED.until), cpu = EXCLUDED.cpu`;
      return undefined;
    }
    return yield* bindSpare(company, owner, now, waited, clocks, {
      taskId: row.taskId,
      deploymentRevision: row.deploymentRevision
    });
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
  /**
   * Moves the oldest binding on an earlier revision that a current spare can take onto that
   * spare. Holds the rollout row shared until it commits, then tries each candidate company's
   * claim lock only: a company a claim holds is passed over, so no busy company holds up a
   * promotion or a flip waiting on this. It rechecks that the binding still needs replacing,
   * sizes it once, and fences it only with a locked spare of the right kind in hand, by the
   * claim's rule. A candidate with no such spare is passed over for the next.
   */
  const replaceDeploymentBinding = Effect.fn("FleetStore.replaceDeploymentBinding")(function* (
    owner: string,
    now: number
  ) {
    const rollout = (yield* sql`SELECT ${rolloutColumns} FROM execution_rollout
      WHERE singleton FOR SHARE`.pipe(Effect.flatMap(decodeRollouts)))[0];
    const revision = rollout?.currentRevision;
    if (!rollout || revision === null || revision === undefined) return undefined;
    // One unfinished replacement at a time keeps draining calls within the fleet budget.
    const pending = yield* sql`SELECT binding_id FROM execution_bindings
      WHERE state = 'stopping' AND release_cause = 'deployment' LIMIT 1`;
    if (pending.length > 0) return undefined;
    const candidates = yield* sql<{ readonly companyId: string }>`SELECT b.company_id AS "companyId"
      FROM execution_bindings b JOIN execution_tasks t ON t.task_id = b.task_id
      WHERE b.state IN ('active', 'claiming') AND t.deployment_revision <> ${revision}
      ORDER BY b.binding_id`;
    for (const { companyId: company } of candidates) {
      if (!(yield* exclusive(claimLock(company)))) continue;
      const previous = (yield* findCompany(company))[0];
      if (!previous) continue;
      const stale = yield* sql`SELECT 1 FROM execution_tasks
        WHERE task_id = ${previous.taskId} AND deployment_revision <> ${revision}`;
      if (stale.length === 0) continue;
      const needed = yield* neededSize(company, rollout.smallBoxes);
      const spare = yield* sql`SELECT ${taskColumns} FROM execution_tasks
        WHERE state = 'spare' AND deployment_revision = ${revision} AND cpu >= ${needed.cpu}
        ORDER BY cpu, requested_at FOR UPDATE SKIP LOCKED LIMIT 1`.pipe(
        Effect.flatMap(decodeTasks)
      );
      if (!spare[0]) continue;
      const fenced = yield* fence(previous, "deployment");
      if (!fenced[0]) continue;
      yield* sql`UPDATE execution_tasks SET state = 'bound' WHERE task_id = ${spare[0].taskId}`;
      // The replacement keeps both clocks running from where its predecessor's stood.
      const replacement = yield* bindSpare(company, owner, now, 0, fenced[0], spare[0]);
      return { previous: fenced[0], replacement };
    }
    return undefined;
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
  // A prewarm's runs neither.
  const clockOf = (caller: Exclude<Caller, "prewarm">) =>
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
    if (caller === "prewarm") return;
    const run = sql`UPDATE execution_bindings
      SET ${clockOf(caller)} = GREATEST(${clockOf(caller)}, ${now})
      WHERE company_id = ${company} AND state IN ('claiming', 'active') RETURNING binding_id`;
    if ((yield* run).length === 0) yield* run;
  });
  const protect = (binding: Binding, until: number, now: number, caller: Caller) =>
    sql`UPDATE execution_bindings
    SET protected_until = GREATEST(protected_until, ${until})${
      caller === "prewarm"
        ? sql.literal("")
        : sql`, ${clockOf(caller)} = GREATEST(${clockOf(caller)}, ${now})`
    }
    WHERE binding_epoch = ${binding.bindingEpoch} AND state = 'active' AND ${admissibleTask}
    RETURNING ${bindingColumns}, ${boundCpu}`.pipe(Effect.flatMap(decodeSized));
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
   * Releases a binding once no document or prewarm holds it, no admitted work is in flight on it
   * or on a binding of the company still draining, and both clocks have run out: `idleMs` from
   * the documents' last activity, `agentIdleMs` from an agent's last call settling. Work in
   * flight moves neither clock until it settles. A prewarm defers release without restarting
   * the documents' window, and a binding whose clocks never ran is released `unused`.
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
    if (!(yield* exclusive(prewarmLock(binding.companyId)))) return [];
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
    return yield* fence(
      current,
      current.lastActivityAt === 0 && current.agentActivityAt === 0 ? "unused" : "idle"
    );
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
      agent_only = CASE WHEN b.last_activity_at = 0 AND b.agent_activity_at = 0 THEN NULL
        ELSE b.last_activity_at = 0 END
      FROM execution_bindings b WHERE h.binding_id = b.binding_id AND h.task_id = ${taskId}
        AND h.released_at IS NULL`;
  }, sql.withTransaction);
  /**
   * Records a running task no live row knows, to be stopped, at the size the provider observed
   * or as a full box when it observed none. A row that was never bound takes that size again
   * when its task is seen running after it was recorded stopped; a bound row keeps its own.
   * Either way its launch history is unknown from then on: it was seen running.
   */
  const recordOrphan = Effect.fn("FleetStore.recordOrphan")(function* (
    task: TaskProvider.Task,
    now: number
  ) {
    const size = task.size ?? full;
    yield* sql`INSERT INTO execution_deployments(revision, retired)
      VALUES (${task.deploymentRevision}, true) ON CONFLICT DO NOTHING`;
    // The insert can race a reservation made after the inventory snapshot.
    const rows = yield* sql`INSERT INTO execution_tasks
      (task_id, deployment_revision, state, requested_at, started_at, cpu, memory)
      VALUES (${task.taskId}, ${task.deploymentRevision}, 'stopping', ${now}, ${task.startedAt},
        ${size.cpu}, ${size.memory})
      ON CONFLICT (task_id) DO UPDATE SET state = 'stopping', stopped_at = NULL,
        unrefused_launches = NULL,
        cpu = CASE WHEN EXISTS (SELECT 1 FROM execution_bindings b
          WHERE b.task_id = execution_tasks.task_id) THEN execution_tasks.cpu ELSE EXCLUDED.cpu END,
        memory = CASE WHEN EXISTS (SELECT 1 FROM execution_bindings b
          WHERE b.task_id = execution_tasks.task_id) THEN execution_tasks.memory ELSE EXCLUDED.memory END
        WHERE execution_tasks.state = 'stopped'
      RETURNING task_id`;
    return rows.length === 1;
  }, sql.withTransaction);
  /**
   * Counts a launch attempt before it is sent, so a row never reads as having launched nothing
   * while one may be in flight, and an attempt whose outcome is never learned keeps it uncertain
   * for good; an unknown count stays unknown. Answers false for a row already stopped, which is
   * not launched again.
   */
  const launching = (taskId: string) =>
    sql`UPDATE execution_tasks SET unrefused_launches = unrefused_launches + 1
    WHERE task_id = ${taskId} AND state <> 'stopped' RETURNING task_id`.pipe(
      Effect.map((rows) => rows.length === 1)
    );
  // Takes back the count of an attempt the provider refused outright: it created nothing.
  const launchRefused = (taskId: string) =>
    sql`UPDATE execution_tasks SET unrefused_launches = unrefused_launches - 1
    WHERE task_id = ${taskId} AND unrefused_launches > 0`;
  // The provider showed these rows' tasks running: whatever was counted, something was launched.
  const launchSeen = (taskIds: ReadonlyArray<string>) =>
    sql`UPDATE execution_tasks SET unrefused_launches = NULL
    WHERE ${sql.in("task_id", taskIds)} AND unrefused_launches IS NOT NULL`;
  /**
   * Completes the drain of a row that asked for a small box and certainly launched nothing,
   * having nothing to stop. Answers whether it did. A row with no attempt left uncounted never
   * started, so its `cpu` is still the size it asked for.
   */
  const stopUnlaunched = Effect.fn("FleetStore.stopUnlaunched")(function* (
    taskId: string,
    stoppedAt: number
  ) {
    const rows = yield* sql`UPDATE execution_tasks SET state = 'stopped', stopped_at = ${stoppedAt}
      WHERE task_id = ${taskId} AND state = 'stopping' AND ready_at IS NULL
        AND cpu < ${full.cpu} AND unrefused_launches = 0
      RETURNING task_id`;
    return rows.length === 1;
  });
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
  const rollout = currentRollout.pipe(
    Effect.flatMap(decodeRollouts),
    Effect.map((rows) => rows[0]!)
  );
  // Whether a small spare of `revision` may be created or kept: small boxes are on and it is the
  // current revision. A row that matches stays locked until the transaction ends, so a flip or a
  // promotion waits for the write that relied on it.
  const smallAllowed = (revision: string) =>
    sql`SELECT singleton FROM execution_rollout
    WHERE singleton AND small_boxes AND current_revision = ${revision} FOR SHARE`.pipe(
      Effect.map((rows) => rows.length === 1)
    );
  /** Turns small boxes on or off, controller code for the operator command, never a row edit. */
  const setSmallBoxes = (on: boolean) =>
    sql`UPDATE execution_rollout SET small_boxes = ${on} WHERE singleton`.pipe(Effect.asVoid);
  /**
   * The switch, small tasks and possibly small rows never admitted, from one snapshot. A row never
   * admitted keeps the size it asked for, or the size it was observed at when fenced at readiness.
   */
  const smallBoxesStatus = sql`SELECT r.small_boxes AS "smallBoxes",
      COALESCE((SELECT json_object_agg(s.state, s.tasks) FROM (
        SELECT state, count(*)::integer AS tasks FROM execution_tasks
        WHERE cpu < ${full.cpu} AND ready_at IS NOT NULL AND state <> 'stopped' GROUP BY state
      ) s), '{}'::json) AS small,
      COALESCE((SELECT json_agg(json_build_object('taskId', task_id, 'state', state, 'cpu', cpu,
          'launchedNothing', COALESCE(unrefused_launches = 0, false)) ORDER BY requested_at)
        FROM execution_tasks
        WHERE cpu < ${full.cpu} AND ready_at IS NULL AND state <> 'stopped'), '[]'::json) AS unverified
    FROM execution_rollout r WHERE r.singleton`.pipe(
    Effect.flatMap(decodeStatus),
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
        AND (SELECT count(*) FROM execution_tasks WHERE deployment_revision = ${revision}
          AND state = 'spare' AND cpu >= ${full.cpu}) >= ${minimumSpares}
      RETURNING singleton`.pipe(Effect.map((rows) => rows.length === 1));
  }, sql.withTransaction);
  const retireDeployment = Effect.fn("FleetStore.retireDeployment")(function* (revision: string) {
    yield* sql`UPDATE execution_rollout SET
      current_revision = CASE WHEN current_revision = ${revision} THEN NULL ELSE current_revision END,
      staged_revision = CASE WHEN staged_revision = ${revision} THEN NULL ELSE staged_revision END
      WHERE singleton`;
    yield* sql`UPDATE execution_deployments SET retired = true WHERE revision = ${revision}`;
  }, sql.withTransaction);
  // A spare row of this size's kind: full ones serve anyone, smaller ones only a one-member company.
  const ofKind = (size: TaskProvider.Size) =>
    TaskProvider.isSmall(size) ? sql`cpu < ${full.cpu}` : sql`cpu >= ${full.cpu}`;
  /**
   * Reserves a `starting` row of `size` for `revision` while the leased replica holds its lease
   * and the live charge plus a full box stays within `budget` vCPU. A small one is reserved only
   * for the current revision while small boxes are on, rechecked under the rollout row's lock,
   * and starts counting its launch attempts from none; a full one's count stays unknown, since
   * only a small row's drain may complete without a stop.
   */
  const reserve = Effect.fn("FleetStore.reserve")(function* (
    taskId: string,
    revision: string,
    size: TaskProvider.Size,
    owner: string,
    epoch: number,
    now: number,
    budget: number
  ) {
    if (TaskProvider.isSmall(size) && !(yield* smallAllowed(revision)))
      return { outcome: "small_off" } as const;
    const held = yield* sql`SELECT lease_epoch AS "leaseEpoch" FROM execution_housekeeping
      WHERE owner_id = ${owner} AND lease_epoch = ${epoch} AND expires_at > ${now} FOR UPDATE`.pipe(
      Effect.flatMap(decodeLeases)
    );
    if (!held[0]) return { outcome: "lease_lost" } as const;
    const rows = yield* sql`WITH state AS (
        SELECT
          ${room(budget)} AS room,
          (EXISTS (SELECT 1 FROM execution_deployments WHERE revision = ${revision} AND NOT retired)
            AND EXISTS (SELECT 1 FROM execution_rollout WHERE singleton
              AND (current_revision = ${revision} OR staged_revision = ${revision}))) AS listed,
          (SELECT count(*)::integer FROM execution_tasks
            WHERE state IN ('starting', 'spare') AND deployment_revision = ${revision}
              AND ${ofKind(size)}) AS spares
      ), inserted AS (
        INSERT INTO execution_tasks
          (task_id, deployment_revision, state, requested_at, cpu, memory, unrefused_launches)
        SELECT ${taskId}, ${revision}, 'starting', ${now}, ${size.cpu}, ${size.memory},
          ${TaskProvider.isSmall(size) ? 0 : null}::integer
        FROM state WHERE room AND listed
        RETURNING task_id
      )
      SELECT
        (SELECT count(*) > 0 FROM inserted) AS reserved,
        state.listed,
        state.spares
      FROM state`.pipe(Effect.flatMap(decodeReserveRows));
    const row = rows[0]!;
    if (row.reserved) return { outcome: "reserved" } as const;
    if (!row.listed) return { outcome: "retired" } as const;
    return { outcome: "budget", spares: row.spares } as const;
  }, sql.withTransaction);
  /**
   * Admits a launched task as a spare of the size the provider observed, written with its
   * readiness in one statement; a bound row's size is never rewritten. A full launch sends no
   * size, so one the provider observed no valid size for runs at the definition's and is
   * admitted full. A small launch with no valid size observed is fenced to drain, and so is a
   * task that asked for or runs at a small box unless small boxes are on and its revision is
   * current, rechecked under the rollout row's lock. A fenced row records the size it was
   * observed at but stays unverified, so it is charged a full box until it stops. Either way its
   * task was seen running, so its launch history is unknown from then on.
   */
  const ready = Effect.fn("FleetStore.ready")(function* (
    task: TaskProvider.Task,
    requested: TaskProvider.Size
  ) {
    const size = task.size ?? (TaskProvider.isSmall(requested) ? undefined : full);
    if (
      size === undefined ||
      ((TaskProvider.isSmall(size) || TaskProvider.isSmall(requested)) &&
        !(yield* smallAllowed(task.deploymentRevision)))
    ) {
      const observed = task.size ?? requested;
      const fenced = yield* sql`UPDATE execution_tasks SET state = 'stopping',
          cpu = ${observed.cpu}, memory = ${observed.memory}, unrefused_launches = NULL
        WHERE task_id = ${task.taskId} AND state = 'starting' RETURNING task_id`;
      return fenced.length === 1 ? ("drain" as const) : ("gone" as const);
    }
    const admitted = yield* sql`UPDATE execution_tasks
      SET started_at = ${task.startedAt}, ready_at = ${task.readyAt}, state = 'spare',
        cpu = ${size.cpu}, memory = ${size.memory}, unrefused_launches = NULL
      WHERE task_id = ${task.taskId} AND state = 'starting' RETURNING task_id`;
    return admitted.length === 1 ? ("spare" as const) : ("gone" as const);
  }, sql.withTransaction);
  /**
   * Fences ready spares of `revision` and `size`'s kind beyond the oldest `keep` unclaimed ready
   * spares, newest first, whose readiness predates `readyBefore`. Locking inside the same
   * statement ensures a concurrent claim can never make trimming dip below `keep`. A small trim
   * first takes a shared lock on the rollout row, held until it commits, and decides under it:
   * unless small boxes are on and `revision` is current, it keeps none; if they are, but
   * `smallBoxes`, the switch its pass planned `keep` with, was off, it fences nothing and leaves
   * the spares to the next pass. A flip or a promotion so lands either before that decision or
   * after the fence. A full trim takes no such lock and ignores `smallBoxes`.
   */
  const trimSpares = Effect.fn("FleetStore.trimSpares")(function* (
    revision: string,
    size: TaskProvider.Size,
    keep: number,
    readyBefore: number,
    smallBoxes: boolean
  ) {
    const allowed = TaskProvider.isSmall(size)
      ? yield* sql`SELECT singleton FROM execution_rollout WHERE singleton FOR SHARE`.pipe(
          Effect.andThen(smallAllowed(revision))
        )
      : true;
    if (TaskProvider.isSmall(size) && allowed && !smallBoxes) return [];
    const kept = allowed ? keep : 0;
    return yield* sql<{ readonly taskId: string }>`WITH locked AS (
        SELECT task_id, requested_at, ready_at
        FROM execution_tasks
        WHERE state = 'spare' AND deployment_revision = ${revision} AND ${ofKind(size)}
        ORDER BY requested_at ASC
        FOR UPDATE SKIP LOCKED
      ), ranked AS (
        SELECT task_id, ready_at, row_number() OVER (ORDER BY requested_at ASC) AS rank
        FROM locked
      )
      UPDATE execution_tasks t SET state = 'stopping'
      FROM ranked
      WHERE t.task_id = ranked.task_id
        AND t.state = 'spare'
        AND ranked.rank > ${kept}
        AND ranked.ready_at IS NOT NULL
        AND ranked.ready_at <= ${readyBefore}
      RETURNING t.task_id AS "taskId"`.pipe(Effect.map((rows) => rows.map((row) => row.taskId)));
  }, sql.withTransaction);
  /**
   * Fences a small spare to drain only while it still is one and its revision is still not the
   * current one, read under a shared lock on the rollout row, so a promotion commits either
   * before this, which then moves nothing, or after it. A spare is unbound: the statement that
   * binds a spare makes its row `bound`. Answers whether it moved the row.
   */
  const fenceSmallSpare = (taskId: string) =>
    sql`UPDATE execution_tasks SET state = 'stopping'
    WHERE task_id = ${taskId} AND state = 'spare' AND cpu < ${full.cpu}
      AND EXISTS (SELECT 1 FROM execution_rollout r WHERE r.singleton
        AND r.current_revision IS DISTINCT FROM execution_tasks.deployment_revision FOR SHARE)
    RETURNING task_id`.pipe(Effect.map((rows) => rows.length === 1));
  const sweepWaits = (now: number) => sql`DELETE FROM execution_pool_waits WHERE until <= ${now}`;
  /**
   * Each size's demand on `revision`: wakes by the size of the spare each consumed, cold start by
   * the size of the task, starting and ready spares of the revision by kind, and companies still
   * waiting by the size they need. With `smallBoxes` off, a wait recorded as small is full demand.
   */
  const target = (now: number, window: number, revision: string, smallBoxes: boolean) =>
    sql`WITH wakes AS (
      SELECT count(*) FILTER (WHERE t.cpu >= ${full.cpu})::integer AS full,
        count(*) FILTER (WHERE t.cpu < ${full.cpu})::integer AS small
      FROM execution_binding_history h JOIN execution_tasks t ON t.task_id = h.task_id
      WHERE h.bound_at >= ${now - window}
    ), cold AS (
      SELECT COALESCE(avg(ready_at - requested_at) FILTER (WHERE cpu >= ${full.cpu}), 0)::double precision AS full,
        COALESCE(avg(ready_at - requested_at) FILTER (WHERE cpu < ${full.cpu}), 0)::double precision AS small
      FROM execution_tasks WHERE ready_at IS NOT NULL AND requested_at >= ${now - window}
    ), pool AS (
      SELECT count(*) FILTER (WHERE cpu >= ${full.cpu})::integer AS full,
        count(*) FILTER (WHERE cpu < ${full.cpu})::integer AS small,
        count(*) FILTER (WHERE state = 'spare' AND cpu >= ${full.cpu})::integer AS full_ready,
        count(*) FILTER (WHERE state = 'spare' AND cpu < ${full.cpu})::integer AS small_ready
      FROM execution_tasks WHERE state IN ('starting', 'spare') AND deployment_revision = ${revision}
    ), waiting AS (
      SELECT count(*) FILTER (WHERE w.cpu >= ${full.cpu} OR NOT ${smallBoxes})::integer AS full,
        count(*) FILTER (WHERE w.cpu < ${full.cpu} AND ${smallBoxes})::integer AS small
      FROM execution_pool_waits w
      WHERE w.until > ${now}
        AND NOT EXISTS (
          SELECT 1 FROM execution_bindings b
          WHERE b.company_id = w.company_id AND b.state IN ('claiming', 'active')
        )
    )
    SELECT wakes.full AS "fullWakes", wakes.small AS "smallWakes",
      cold.full AS "fullColdStart", cold.small AS "smallColdStart",
      pool.full AS "fullSpares", pool.small AS "smallSpares",
      pool.full_ready AS "fullReadySpares", pool.small_ready AS "smallReadySpares",
      waiting.full AS "fullWaiting", waiting.small AS "smallWaiting"
    FROM wakes, cold, pool, waiting`.pipe(
      Effect.flatMap(decodeTargets),
      Effect.map(([row]): { readonly full: Demand; readonly small: Demand } => ({
        full: {
          wakes: row!.fullWakes,
          coldStart: row!.fullColdStart,
          spares: row!.fullSpares,
          readySpares: row!.fullReadySpares,
          waiting: row!.fullWaiting
        },
        small: {
          wakes: row!.smallWakes,
          coldStart: row!.smallColdStart,
          spares: row!.smallSpares,
          readySpares: row!.smallReadySpares,
          waiting: row!.smallWaiting
        }
      }))
    );
  const pendingEvents = SqlSchema.findAll({
    Request: Schema.Void,
    Result: History,
    execute: () => sql`SELECT ${historyColumns}
      FROM execution_binding_history h JOIN execution_tasks t ON t.task_id = h.task_id
      WHERE h.released_at IS NOT NULL AND NOT h.event_emitted`
  });
  // A task's CPU units, for the process events its supervisor reports.
  const taskCpu = (taskId: string) =>
    sql`SELECT cpu FROM execution_tasks WHERE task_id = ${taskId}`.pipe(
      Effect.flatMap(decodeCpus),
      Effect.map((rows) => rows[0]?.cpu)
    );
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
    launching,
    launchRefused,
    launchSeen,
    stopUnlaunched,
    lease,
    renewLease,
    registerDeployment,
    rollout,
    setSmallBoxes,
    smallBoxesStatus,
    stageDeployment,
    promoteDeployment,
    retireDeployment,
    reserve,
    ready,
    trimSpares,
    fenceSmallSpare,
    sweepWaits,
    target,
    pendingEvents,
    taskCpu,
    markEvent,
    pausedUntil,
    report,
    peak
  };
});
