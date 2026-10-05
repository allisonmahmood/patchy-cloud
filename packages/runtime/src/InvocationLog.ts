import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { AgentIdentity, HandlerKind } from "@patchy/api";

const encodeAgent = Schema.encodeSync(Schema.fromJsonString(AgentIdentity));

export const Outcome = Schema.Literals([
  "pending",
  "success",
  "handler_error",
  "failure",
  "handler_timeout",
  "unknown_outcome"
]);
export type Outcome = typeof Outcome.Type;

export interface Begin {
  readonly id: string;
  readonly companyId: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly handler: string;
  readonly kind: typeof HandlerKind.Type;
  readonly initiatingViewerId: string;
  readonly agent?: AgentIdentity | null;
  readonly parentId: string | null;
  readonly correlationId: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly argsBytes: number;
}

export interface Finish {
  readonly id: string;
  readonly outcome: Exclude<Outcome, "pending">;
  readonly outcomeCode: string | null;
  readonly settledAt: number;
  readonly durationMs: number;
  readonly guestMs: number;
  readonly dbMs: number;
  readonly callbacks: number;
  readonly resultBytes: number;
  readonly attempts: number;
  readonly logLines: ReadonlyArray<typeof Schema.Json.Type>;
  readonly replyDelivered: boolean;
}

export class Invocation extends Schema.Class<Invocation>("InvocationLog.Invocation")({
  id: Schema.String,
  companyId: Schema.String,
  patchId: Schema.String,
  versionId: Schema.String,
  handler: Schema.String,
  kind: HandlerKind,
  initiatingViewerId: Schema.String,
  agent: Schema.NullOr(AgentIdentity),
  effectivePrincipal: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  outcome: Outcome,
  outcomeCode: Schema.NullOr(Schema.String),
  correlationId: Schema.String,
  startedAt: Schema.Date,
  deadline: Schema.Date,
  settledAt: Schema.NullOr(Schema.Date),
  durationMs: Schema.NullOr(Schema.Int),
  guestMs: Schema.Int,
  dbMs: Schema.Int,
  callbacks: Schema.Int,
  argsBytes: Schema.Int,
  resultBytes: Schema.Int,
  attempts: Schema.Int,
  logLines: Schema.Array(Schema.Json),
  replyDelivered: Schema.Boolean
}) {}

/** One step inside a logged invocation: a nested handler or an operation row it made. */
export const TreeItem = Schema.Struct({
  type: Schema.Literals(["invocation", "call"]),
  id: Schema.String,
  /** The invocation this step belongs to: the entry itself or a nested handler inside it. */
  parentId: Schema.String,
  at: Schema.Date,
  /** A handler name for nested invocations, an operation such as `tables.insert` for calls. */
  name: Schema.String,
  kind: Schema.NullOr(HandlerKind),
  resource: Schema.NullOr(Schema.String),
  effectivePrincipal: Schema.String,
  outcome: Outcome,
  outcomeCode: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Int),
  attempts: Schema.Int,
  rowCount: Schema.NullOr(Schema.Int),
  /** The company connection an integration call went to, as stored on its operation row. */
  connectionId: Schema.NullOr(Schema.String),
  logLines: Schema.Array(Schema.Json)
});
export type TreeItem = typeof TreeItem.Type;

/** Filters over a patch's top-level entries. `failed` covers every settled outcome but success. */
export interface PageFilter {
  readonly outcome?: "succeeded" | "failed" | "unknown";
  readonly viewerId?: string;
  readonly handler?: string;
}

export interface Entry {
  readonly invocation: Invocation;
  /**
   * At most `TREE_LIMIT` steps inside the entry, shallowest first, each after its parent, so
   * every kept step's parent is kept too. Each parent's own steps are in time order.
   */
  readonly tree: ReadonlyArray<TreeItem>;
  /** The entry made more steps than `tree` holds. */
  readonly truncated: boolean;
}

/** An entry shows at most this many steps; reading them is bounded the same way. */
export const TREE_LIMIT = 50;
/**
 * Filters and filter choices read this many of a patch's newest top-level entries at a time,
 * so a filter that rarely matches never walks the patch's whole history in one request.
 */
export const FILTER_WINDOW = 1_000;

const encodeLogLines = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)));

export class InvocationLog extends Context.Service<
  InvocationLog,
  {
    readonly begin: (input: Begin) => Effect.Effect<string, SqlError>;
    readonly finish: (input: Finish) => Effect.Effect<void, SqlError>;
    /** Apply stored mutation commit proof without replacing the original settlement facts. */
    readonly reconcileMutation: (input: {
      readonly companyId: string;
      readonly invocationId: string;
    }) => Effect.Effect<void, SqlError>;
    readonly find: (input: {
      readonly companyId: string;
      readonly invocationId: string;
    }) => Effect.Effect<Invocation | null, SqlError>;
    /**
     * A patch's top-level entries newest first, each with its bounded tree. `before` is the
     * id of the last entry already shown; an id outside this patch yields an empty page.
     */
    readonly page: (input: {
      readonly companyId: string;
      readonly patchId: string;
      readonly before?: string;
      readonly filter?: PageFilter;
      readonly limit: number;
      /** Read each entry's steps; the card's summary skips them. Defaults to true. */
      readonly trees?: boolean;
    }) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<Entry>;
        /** The cursor for older entries, or null at the start of the log. */
        readonly next: string | null;
        /** A filtered read stopped at the edge of its `FILTER_WINDOW`, with older entries beyond. */
        readonly windowEnded: boolean;
      },
      SqlError
    >;
    /** The handlers and initiating viewers among a patch's newest entries, for filtering. */
    readonly choices: (input: {
      readonly companyId: string;
      readonly patchId: string;
    }) => Effect.Effect<
      { readonly handlers: ReadonlyArray<string>; readonly viewerIds: ReadonlyArray<string> },
      SqlError
    >;
  }
>()("@patchy/runtime/InvocationLog") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Commit proof wins; a pending row past its deadline reads as unknown, never as failed.
  const outcomeOf = (now: number) => sql`
    CASE WHEN mutation_committed THEN 'success'
      WHEN outcome = 'pending' AND deadline <= to_timestamp(${now / 1_000})
      THEN 'unknown_outcome' ELSE outcome END`;
  const columns = (now: number) => sql`
    id, company_id AS "companyId", patch_id AS "patchId", version_id AS "versionId",
    handler, kind, initiating_viewer_id AS "initiatingViewerId",
    agent,
    effective_principal AS "effectivePrincipal", parent_id AS "parentId",
    ${outcomeOf(now)} AS outcome,
    CASE WHEN mutation_committed THEN NULL ELSE outcome_code END AS "outcomeCode",
    correlation_id AS "correlationId",
    started_at AS "startedAt", deadline, settled_at AS "settledAt",
    duration_ms AS "durationMs", guest_ms AS "guestMs", db_ms AS "dbMs", callbacks,
    args_bytes AS "argsBytes", result_bytes AS "resultBytes", attempts,
    log_lines AS "logLines", reply_delivered AS "replyDelivered"`;
  const findInvocation = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      invocationId: Schema.String,
      now: Schema.Number
    }),
    Result: Invocation,
    execute: ({ companyId, invocationId, now }) => sql`
      SELECT ${columns(now)}
      FROM runtime_invocations
      WHERE company_id = ${companyId} AND id = ${invocationId}`
  });
  const Filters = Schema.Struct({
    companyId: Schema.String,
    patchId: Schema.String,
    before: Schema.NullOr(Schema.String),
    outcome: Schema.NullOr(Schema.Literals(["succeeded", "failed", "unknown"])),
    viewerId: Schema.NullOr(Schema.String),
    handler: Schema.NullOr(Schema.String),
    limit: Schema.Int,
    now: Schema.Number
  });
  const topLevel = (input: {
    readonly companyId: string;
    readonly patchId: string;
    readonly before: string | null;
  }) => sql`
    company_id = ${input.companyId} AND patch_id = ${input.patchId} AND parent_id IS NULL
    ${
      input.before === null
        ? sql``
        : sql`AND (started_at, id) < (SELECT started_at, id FROM runtime_invocations
            WHERE company_id = ${input.companyId} AND patch_id = ${input.patchId}
              AND id = ${input.before})`
    }`;
  const pageEntries = SqlSchema.findAll({
    Request: Filters,
    Result: Invocation,
    execute: (input) => {
      const { outcome, viewerId, handler, limit, now } = input;
      if (outcome === null && viewerId === null && handler === null)
        return sql`
          SELECT ${columns(now)} FROM runtime_invocations WHERE ${topLevel(input)}
          ORDER BY started_at DESC, id DESC LIMIT ${limit}`;
      // Filters apply inside the newest FILTER_WINDOW entries after the cursor, never the
      // patch's whole history; the page carries on from the window's edge.
      return sql`
        SELECT ${columns(now)}
        FROM (
          SELECT * FROM runtime_invocations WHERE ${topLevel(input)}
          ORDER BY started_at DESC, id DESC LIMIT ${FILTER_WINDOW}
        ) recent
        WHERE true
          ${viewerId === null ? sql`` : sql`AND initiating_viewer_id = ${viewerId}`}
          ${handler === null ? sql`` : sql`AND handler = ${handler}`}
          ${
            outcome === null
              ? sql``
              : outcome === "succeeded"
                ? sql`AND ${outcomeOf(now)} = 'success'`
                : outcome === "unknown"
                  ? sql`AND ${outcomeOf(now)} = 'unknown_outcome'`
                  : sql`AND ${outcomeOf(now)} IN ('handler_error', 'failure', 'handler_timeout')`
          }
        ORDER BY started_at DESC, id DESC LIMIT ${limit}`;
    }
  });
  // The oldest entry of a full filter window, returned only when older entries exist beyond it.
  const windowEdge = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      patchId: Schema.String,
      before: Schema.NullOr(Schema.String)
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      SELECT id FROM runtime_invocations WHERE ${topLevel(input)}
      ORDER BY started_at DESC, id DESC OFFSET ${FILTER_WINDOW - 1} LIMIT 2`
  });
  const steps = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      parents: Schema.Array(Schema.Struct({ id: Schema.String, limit: Schema.Int })),
      now: Schema.Number
    }),
    Result: TreeItem,
    // Each parent reads at most its limit of nested handlers and of operation rows, through
    // the parent and invocation indexes, however many steps it made.
    execute: ({ companyId, parents, now }) => sql`
      SELECT step.* FROM (VALUES ${sql.join(
        ", ",
        false
      )(
        parents.map((parent) => sql`(${parent.id}::text, ${parent.limit}::int)`)
      )}) AS parent (id, lim)
      CROSS JOIN LATERAL (
        (SELECT 'invocation' AS type, i.id, i.parent_id AS "parentId", i.started_at AS at,
          i.handler AS name, i.kind, NULL::text AS resource,
          i.effective_principal AS "effectivePrincipal",
          CASE WHEN i.mutation_committed THEN 'success'
            WHEN i.outcome = 'pending' AND i.deadline <= to_timestamp(${now / 1_000})
            THEN 'unknown_outcome' ELSE i.outcome END AS outcome,
          CASE WHEN i.mutation_committed THEN NULL ELSE i.outcome_code END AS "outcomeCode",
          i.duration_ms AS "durationMs", i.attempts, NULL::integer AS "rowCount",
          NULL::text AS "connectionId", i.log_lines AS "logLines"
        FROM runtime_invocations i
        WHERE i.company_id = ${companyId} AND i.parent_id = parent.id
        ORDER BY i.started_at, i.id LIMIT parent.lim)
        UNION ALL
        (SELECT 'call', c.id, c.invocation_id, c.at, c.op, NULL, c.resource,
          c.effective_principal,
          CASE WHEN c.outcome = 'unknown' OR (c.outcome = 'pending'
              AND c.at + c.deadline_ms * interval '1 millisecond' < to_timestamp(${now / 1_000}))
            THEN 'unknown_outcome' ELSE c.outcome END,
          c.outcome_code, c.duration_ms, 1, c.row_count, c.connection_id, '[]'::jsonb
        FROM runtime_calls c
        WHERE c.company_id = ${companyId} AND c.invocation_id = parent.id
        ORDER BY c.at, c.id LIMIT parent.lim)
      ) step`
  });
  const recentChoices = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String }),
    Result: Schema.Struct({ handler: Schema.String, viewerId: Schema.String }),
    execute: ({ companyId, patchId }) => sql`
      SELECT DISTINCT handler, initiating_viewer_id AS "viewerId"
      FROM (
        SELECT handler, initiating_viewer_id FROM runtime_invocations
        WHERE company_id = ${companyId} AND patch_id = ${patchId} AND parent_id IS NULL
        ORDER BY started_at DESC, id DESC
        LIMIT ${FILTER_WINDOW}
      ) recent`
  });

  const begin = Effect.fn("InvocationLog.begin")(function* (input: Begin) {
    yield* sql`
      INSERT INTO runtime_invocations (id, company_id, patch_id, version_id, handler, kind,
        initiating_viewer_id, effective_principal, parent_id, correlation_id, started_at,
        deadline, args_bytes, agent)
      VALUES (${input.id}, ${input.companyId}, ${input.patchId}, ${input.versionId},
        ${input.handler}, ${input.kind}, ${input.initiatingViewerId}, 'patch', ${input.parentId},
        ${input.correlationId}, to_timestamp(${input.startedAt / 1_000}),
        to_timestamp(${input.deadline / 1_000}), ${input.argsBytes}, ${input.agent == null ? null : encodeAgent(input.agent)}::jsonb)`;
    return input.id;
  });

  const finish = Effect.fn("InvocationLog.finish")(function* (input: Finish) {
    yield* sql`
      UPDATE runtime_invocations
      SET outcome = CASE WHEN mutation_committed THEN 'success' ELSE ${input.outcome} END,
        outcome_code = CASE WHEN mutation_committed THEN NULL ELSE ${input.outcomeCode} END,
        settled_at = to_timestamp(${input.settledAt / 1_000}), duration_ms = ${input.durationMs},
        guest_ms = ${input.guestMs}, db_ms = ${input.dbMs}, callbacks = ${input.callbacks},
        result_bytes = ${input.resultBytes}, attempts = ${input.attempts},
        log_lines = ${encodeLogLines(input.logLines)}::jsonb, reply_delivered = ${input.replyDelivered}
      WHERE id = ${input.id}
        AND (outcome = 'pending'
          OR (outcome = 'unknown_outcome'
            AND ${input.outcome} IN ('success', 'handler_error', 'failure')))`;
  });

  const reconcileMutation = Effect.fn("InvocationLog.reconcileMutation")(function* (
    input: Parameters<InvocationLog["Service"]["reconcileMutation"]>[0]
  ) {
    // Pending rows may outlive a dead host. A live finalizer can still fill their
    // settlement facts once, but cannot undo success proved by the company commit.
    yield* sql`
      UPDATE runtime_invocations SET mutation_committed = true,
        outcome = CASE WHEN outcome = 'pending' THEN outcome ELSE 'success' END,
        outcome_code = NULL
      WHERE company_id = ${input.companyId} AND id = ${input.invocationId}
        AND kind = 'mutation' AND outcome IN ('pending', 'unknown_outcome')`;
  });

  const find = Effect.fn("InvocationLog.find")(function* (
    input: Parameters<InvocationLog["Service"]["find"]>[0]
  ) {
    const row = yield* findInvocation({ ...input, now: yield* Clock.currentTimeMillis }).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    return Option.getOrNull(row);
  });

  /**
   * Reads each entry's steps a level at a time: a parent's steps are read only once the parent
   * is kept, and never more than its entry has room for plus one, which reveals a cut.
   */
  const trees = Effect.fn("InvocationLog.trees")(function* (
    companyId: string,
    roots: ReadonlyArray<string>,
    now: number
  ) {
    const kept = new Map(roots.map((root) => [root, { tree: [] as TreeItem[], truncated: false }]));
    let frontier = roots.map((root) => ({ id: root, root }));
    while (frontier.length > 0) {
      const open = frontier.filter(({ root }) => !kept.get(root)!.truncated);
      if (open.length === 0) break;
      const rows = yield* steps({
        companyId,
        parents: open.map(({ id, root }) => ({
          id,
          limit: TREE_LIMIT - kept.get(root)!.tree.length + 1
        })),
        now
      }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      const byParent = new Map<string, TreeItem[]>();
      for (const row of rows)
        byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
      const next: typeof frontier = [];
      for (const { id, root } of open) {
        const entry = kept.get(root)!;
        const children = (byParent.get(id) ?? []).sort(
          (a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1)
        );
        for (const child of children) {
          if (entry.tree.length === TREE_LIMIT) {
            entry.truncated = true;
            break;
          }
          entry.tree.push(child);
          if (child.type === "invocation") next.push({ id: child.id, root });
        }
      }
      frontier = next;
    }
    return kept;
  });

  const page = Effect.fn("InvocationLog.page")(function* (
    input: Parameters<InvocationLog["Service"]["page"]>[0]
  ) {
    const now = yield* Clock.currentTimeMillis;
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const scope = {
      companyId: input.companyId,
      patchId: input.patchId,
      before: input.before ?? null
    };
    const filter = input.filter ?? {};
    const rows = yield* pageEntries({
      ...scope,
      outcome: filter.outcome ?? null,
      viewerId: filter.viewerId ?? null,
      handler: filter.handler ?? null,
      limit: limit + 1,
      now
    }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    const shown = rows.slice(0, limit);
    let next = rows.length > limit ? shown.at(-1)!.id : null;
    let windowEnded = false;
    if (
      next === null &&
      (filter.outcome !== undefined ||
        filter.viewerId !== undefined ||
        filter.handler !== undefined)
    ) {
      const edge = yield* windowEdge(scope).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      if (edge.length === 2) {
        next = edge[0]!.id;
        windowEnded = true;
      }
    }
    const read =
      input.trees === false || shown.length === 0
        ? new Map<string, { tree: TreeItem[]; truncated: boolean }>()
        : yield* trees(
            input.companyId,
            shown.map((row) => row.id),
            now
          );
    return {
      entries: shown.map((invocation) => ({
        invocation,
        tree: read.get(invocation.id)?.tree ?? [],
        truncated: read.get(invocation.id)?.truncated ?? false
      })),
      next,
      windowEnded
    };
  });

  const choices = Effect.fn("InvocationLog.choices")(function* (
    input: Parameters<InvocationLog["Service"]["choices"]>[0]
  ) {
    const rows = yield* recentChoices(input).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
    return {
      handlers: sorted(rows.map((row) => row.handler)),
      viewerIds: sorted(rows.map((row) => row.viewerId))
    };
  });

  return InvocationLog.of({ begin, finish, reconcileMutation, find, page, choices });
});

export const layer = Layer.effect(InvocationLog, make);
