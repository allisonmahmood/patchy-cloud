import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { HandlerKind } from "@patchy/api";

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
  /** The first steps inside the entry, oldest first, at most `TREE_LIMIT` of `treeTotal`. */
  readonly tree: ReadonlyArray<TreeItem>;
  readonly treeTotal: number;
}

/** A page of top-level entries holds at most this many steps each; the rest are counted. */
export const TREE_LIMIT = 50;
/** Filter choices come from this many of a patch's newest entries, so reading them stays bounded. */
export const CHOICES_WINDOW = 1_000;

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
    }) => Effect.Effect<
      { readonly entries: ReadonlyArray<Entry>; readonly more: boolean },
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
  const pageEntries = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      patchId: Schema.String,
      before: Schema.NullOr(Schema.String),
      outcome: Schema.NullOr(Schema.Literals(["succeeded", "failed", "unknown"])),
      viewerId: Schema.NullOr(Schema.String),
      handler: Schema.NullOr(Schema.String),
      limit: Schema.Int,
      now: Schema.Number
    }),
    Result: Invocation,
    execute: ({ companyId, patchId, before, outcome, viewerId, handler, limit, now }) => sql`
      SELECT ${columns(now)}
      FROM runtime_invocations
      WHERE company_id = ${companyId} AND patch_id = ${patchId} AND parent_id IS NULL
        ${
          before === null
            ? sql``
            : sql`AND (started_at, id) < (SELECT started_at, id FROM runtime_invocations
                WHERE company_id = ${companyId} AND patch_id = ${patchId} AND id = ${before})`
        }
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
      ORDER BY started_at DESC, id DESC
      LIMIT ${limit}`
  });
  const treeItems = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      roots: Schema.Array(Schema.String),
      now: Schema.Number
    }),
    Result: Schema.Struct({ ...TreeItem.fields, root: Schema.String, total: Schema.Int }),
    // Nested handlers and operation rows, ranked per entry in time order so a nested
    // handler always precedes its own steps and the kept prefix stays a whole tree.
    execute: ({ companyId, roots, now }) => sql`
      WITH RECURSIVE tree (id, root) AS (
        SELECT id, id FROM runtime_invocations
        WHERE company_id = ${companyId} AND ${sql.in("id", roots)}
        UNION ALL
        SELECT child.id, tree.root FROM runtime_invocations child
        JOIN tree ON child.parent_id = tree.id
        WHERE child.company_id = ${companyId}
      ), items AS (
        SELECT tree.root, 'invocation' AS type, i.id, i.parent_id AS "parentId",
          i.started_at AS at, i.handler AS name, i.kind, NULL::text AS resource,
          i.effective_principal AS "effectivePrincipal", ${outcomeOf(now)} AS outcome,
          CASE WHEN mutation_committed THEN NULL ELSE outcome_code END AS "outcomeCode",
          i.duration_ms AS "durationMs", i.attempts, NULL::integer AS "rowCount",
          i.log_lines AS "logLines"
        FROM tree JOIN runtime_invocations i ON i.id = tree.id
        WHERE tree.id <> tree.root
        UNION ALL
        SELECT tree.root, 'call', c.id, c.invocation_id, c.at, c.op, NULL, c.resource,
          c.effective_principal,
          CASE WHEN c.outcome = 'unknown' OR (c.outcome = 'pending'
              AND c.at + c.deadline_ms * interval '1 millisecond' < to_timestamp(${now / 1_000}))
            THEN 'unknown_outcome' ELSE c.outcome END,
          c.outcome_code, c.duration_ms, 1, c.row_count, '[]'::jsonb
        FROM tree JOIN runtime_calls c
          ON c.company_id = ${companyId} AND c.invocation_id = tree.id
      )
      SELECT root, total, type, id, "parentId", at, name, kind, resource,
        "effectivePrincipal", outcome, "outcomeCode", "durationMs", attempts, "rowCount",
        "logLines"
      FROM (
        SELECT items.*, row_number() OVER (PARTITION BY root ORDER BY at, id) AS n,
          (count(*) OVER (PARTITION BY root))::int AS total
        FROM items
      ) ranked
      WHERE n <= ${TREE_LIMIT}
      ORDER BY root, at, id`
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
        LIMIT ${CHOICES_WINDOW}
      ) recent`
  });

  const begin = Effect.fn("InvocationLog.begin")(function* (input: Begin) {
    yield* sql`
      INSERT INTO runtime_invocations (id, company_id, patch_id, version_id, handler, kind,
        initiating_viewer_id, effective_principal, parent_id, correlation_id, started_at,
        deadline, args_bytes)
      VALUES (${input.id}, ${input.companyId}, ${input.patchId}, ${input.versionId},
        ${input.handler}, ${input.kind}, ${input.initiatingViewerId}, 'patch', ${input.parentId},
        ${input.correlationId}, to_timestamp(${input.startedAt / 1_000}),
        to_timestamp(${input.deadline / 1_000}), ${input.argsBytes})`;
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

  const page = Effect.fn("InvocationLog.page")(function* (
    input: Parameters<InvocationLog["Service"]["page"]>[0]
  ) {
    const now = yield* Clock.currentTimeMillis;
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const rows = yield* pageEntries({
      companyId: input.companyId,
      patchId: input.patchId,
      before: input.before ?? null,
      outcome: input.filter?.outcome ?? null,
      viewerId: input.filter?.viewerId ?? null,
      handler: input.filter?.handler ?? null,
      limit: limit + 1,
      now
    }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    const shown = rows.slice(0, limit);
    const trees = new Map<string, { items: TreeItem[]; total: number }>();
    if (shown.length > 0) {
      const items = yield* treeItems({
        companyId: input.companyId,
        roots: shown.map((row) => row.id),
        now
      }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      for (const { root, total, ...item } of items) {
        const tree = trees.get(root) ?? { items: [], total };
        tree.items.push(item);
        trees.set(root, tree);
      }
    }
    return {
      entries: shown.map((invocation) => ({
        invocation,
        tree: trees.get(invocation.id)?.items ?? [],
        treeTotal: trees.get(invocation.id)?.total ?? 0
      })),
      more: rows.length > limit
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
