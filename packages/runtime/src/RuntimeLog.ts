import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { toPostgresText } from "@patchy/api";
import { newInternalId } from "@patchy/core";
import { registry } from "@patchy/limits/registry";

const MUTATION_DEADLINE_MS = registry["runtime.mutation.deadline"].default;

/**
 * The credentials this release records calls under. Every read filters to them, so a call a later
 * release recorded under a new kind stays hidden after a rollback instead of failing to decode.
 */
export const credentialKinds = ["session", "admin", "machine", "agent"] as const;
export type CredentialKind = (typeof credentialKinds)[number];
const MAX_SQL_BYTES = 8_192;
const encoder = new TextEncoder();

interface BeginFields {
  readonly companyId: string;
  readonly userId: string | null;
  readonly effectivePrincipal?: string;
  readonly invocationId?: string | null;
  readonly op: string;
  readonly resource: string | null;
  readonly connectionId: string | null;
  readonly correlationId: string;
  readonly sql?: string;
  /** Elapsed time from begin, including an integration's queue time. */
  readonly deadlineMs?: number;
}

/**
 * A viewer's session or an admin acts from a patch or the connection pages; a person's worker
 * agent from a patch's agent tool; a machine from `patchy dev`.
 */
export type Begin = BeginFields &
  (
    | {
        readonly credentialKind: "session" | "admin";
        readonly patchId: string | null;
        readonly versionId: string | null;
      }
    | {
        readonly credentialKind: "agent";
        readonly agent: Agent;
        readonly patchId: string;
        readonly versionId: string;
      }
    | {
        readonly credentialKind: "machine";
        readonly machine: Machine;
        readonly patchId: null;
        readonly versionId: null;
      }
  );

/** The machine token a dev read came through, as it was named then. */
export const Machine = Schema.Struct({ id: Schema.String, name: Schema.String });
export type Machine = typeof Machine.Type;
/** The worker agent a call ran for, by the client name its person approved at the time. */
export const Agent = Schema.Struct({ name: Schema.String });
export type Agent = typeof Agent.Type;

export class Call extends Schema.Class<Call>("RuntimeLog.Call")({
  id: Schema.String,
  at: Schema.Date,
  companyId: Schema.String,
  patchId: Schema.NullOr(Schema.String),
  versionId: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.String),
  effectivePrincipal: Schema.String,
  invocationId: Schema.NullOr(Schema.String),
  credentialKind: Schema.Literals(credentialKinds),
  /** Only for `machine`, which never names a patch or version. */
  machine: Schema.NullOr(Machine),
  /** Only for `agent`: the person is `userId` for company resources, the agent this one. */
  agent: Schema.NullOr(Agent),
  op: Schema.String,
  resource: Schema.NullOr(Schema.String),
  connectionId: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["pending", "unknown", "success", "handler_error", "failure"]),
  outcomeCode: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Int),
  rowCount: Schema.NullOr(Schema.Int),
  sql: Schema.NullOr(Schema.String),
  correlationId: Schema.String,
  deadlineMs: Schema.Int
}) {}

export class RuntimeLog extends Context.Service<
  RuntimeLog,
  {
    /**
     * Records a pending call before its arguments are checked. `resource` and `sql` are kept as
     * audit text, with U+FFFD for what Postgres text can't hold, so a refused argument is logged.
     */
    readonly begin: (input: Begin) => Effect.Effect<string, SqlError>;
    readonly finish: (input: {
      readonly correlationId: string;
      readonly outcome: "success" | "handler_error" | "failure" | "unknown";
      readonly outcomeCode?: string | null;
      readonly durationMs: number;
      readonly rowCount: number | null;
    }) => Effect.Effect<void, SqlError>;
    readonly find: (input: {
      readonly companyId: string;
      readonly correlationId: string;
    }) => Effect.Effect<Call | null, SqlError>;
    readonly recent: (input: {
      readonly companyId: string;
      readonly connectionId: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<Call>, SqlError>;
    /** When each connection's newest call began; connections never called have no entry. */
    readonly latest: (input: {
      readonly companyId: string;
      readonly connectionIds: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, Date>, SqlError>;
  }
>()("@patchy/runtime/RuntimeLog") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (now: number) => sql`
    id, at, company_id AS "companyId", patch_id AS "patchId", version_id AS "versionId",
    user_id AS "userId", effective_principal AS "effectivePrincipal",
    invocation_id AS "invocationId", credential_kind AS "credentialKind",
    CASE WHEN machine_id IS NULL THEN NULL
      ELSE json_build_object('id', machine_id, 'name', machine_name) END AS machine,
    CASE WHEN agent_name IS NULL THEN NULL ELSE json_build_object('name', agent_name) END AS agent,
    op, resource,
    connection_id AS "connectionId",
    CASE WHEN outcome = 'pending'
      AND at + deadline_ms * interval '1 millisecond' < to_timestamp(${now / 1_000})
      THEN 'unknown' ELSE outcome END AS outcome,
    outcome_code AS "outcomeCode", duration_ms AS "durationMs", row_count AS "rowCount", sql,
    correlation_id AS "correlationId", deadline_ms AS "deadlineMs"`;
  const known = sql`credential_kind IN ${sql.in(credentialKinds)}`;
  const findCall = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      correlationId: Schema.String,
      now: Schema.Number
    }),
    Result: Call,
    execute: ({ companyId, correlationId, now }) => sql`
      SELECT ${columns(now)}
      FROM runtime_calls
      WHERE company_id = ${companyId} AND correlation_id = ${correlationId} AND ${known}`
  });
  const recentCalls = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      connectionId: Schema.String,
      limit: Schema.Int,
      now: Schema.Number
    }),
    Result: Call,
    execute: ({ companyId, connectionId, limit, now }) => sql`
      SELECT ${columns(now)}
      FROM runtime_calls
      WHERE company_id = ${companyId} AND connection_id = ${connectionId} AND ${known}
      ORDER BY at DESC, id DESC LIMIT ${limit}`
  });

  // One index probe per connection, reading past only rows of kinds this release skips.
  const latestCalls = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      connectionIds: Schema.Array(Schema.String)
    }),
    Result: Schema.Struct({ connectionId: Schema.String, at: Schema.Date }),
    execute: ({ companyId, connectionIds }) =>
      sql.unsafe(
        `SELECT connection.id AS "connectionId", newest.at
          FROM unnest($2::text[]) AS connection(id)
          CROSS JOIN LATERAL (
            SELECT at FROM runtime_calls
            WHERE company_id = $1 AND connection_id = connection.id
              AND credential_kind = ANY($3::text[])
            ORDER BY at DESC, id DESC LIMIT 1
          ) AS newest`,
        [companyId, connectionIds, credentialKinds]
      )
  });

  const begin = Effect.fn("RuntimeLog.begin")(function* (input: Begin) {
    const now = yield* Clock.currentTimeMillis;
    const id = newInternalId("call");
    const machine = input.credentialKind === "machine" ? input.machine : null;
    const agent = input.credentialKind === "agent" ? input.agent : null;
    let query: string | null = null;
    // Every integration's query operation is `<integration>.query`, matching the column's check.
    if (input.op.endsWith(".query") && input.sql !== undefined) {
      // Cleaned before the cut, since a stand-in is wider than NUL. encodeInto stops before a
      // partial UTF-8 code point without allocating the whole query.
      const text = toPostgresText(input.sql);
      const { read } = encoder.encodeInto(text, new Uint8Array(MAX_SQL_BYTES));
      query = text.slice(0, read);
    }
    yield* sql`
      INSERT INTO runtime_calls (id, at, company_id, patch_id, version_id, user_id,
        effective_principal, invocation_id, credential_kind, machine_id, machine_name,
        agent_name, op, resource, connection_id, correlation_id, deadline_ms, sql)
      VALUES (${id}, to_timestamp(${now / 1_000}), ${input.companyId}, ${input.patchId},
        ${input.versionId}, ${input.userId}, ${input.effectivePrincipal ?? input.userId},
        ${input.invocationId ?? null}, ${input.credentialKind}, ${machine?.id ?? null},
        ${machine?.name ?? null}, ${agent?.name ?? null}, ${input.op},
        ${input.resource === null ? null : toPostgresText(input.resource)}, ${input.connectionId},
        ${input.correlationId},
        ${input.deadlineMs ?? MUTATION_DEADLINE_MS}, ${query})`;
    return id;
  });

  const finish = Effect.fn("RuntimeLog.finish")(function* (
    input: Parameters<RuntimeLog["Service"]["finish"]>[0]
  ) {
    yield* sql`
      UPDATE runtime_calls SET outcome = ${input.outcome}, duration_ms = ${input.durationMs},
        row_count = ${input.rowCount}, outcome_code = ${input.outcomeCode ?? null}
      WHERE correlation_id = ${input.correlationId} AND outcome = 'pending'`;
  });

  const find = Effect.fn("RuntimeLog.find")(function* (
    input: Parameters<RuntimeLog["Service"]["find"]>[0]
  ) {
    const row = yield* findCall({ ...input, now: yield* Clock.currentTimeMillis }).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    return Option.getOrNull(row);
  });

  const recent = Effect.fn("RuntimeLog.recent")(function* (
    input: Parameters<RuntimeLog["Service"]["recent"]>[0]
  ) {
    return yield* recentCalls({
      ...input,
      limit: Number.isFinite(input.limit)
        ? Math.min(100, Math.max(1, Math.trunc(input.limit!)))
        : 50,
      now: yield* Clock.currentTimeMillis
    }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  });

  const latest = Effect.fn("RuntimeLog.latest")(function* (
    input: Parameters<RuntimeLog["Service"]["latest"]>[0]
  ) {
    if (input.connectionIds.length === 0) return new Map<string, Date>();
    const rows = yield* latestCalls(input).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    return new Map(rows.map((row) => [row.connectionId, row.at]));
  });

  return RuntimeLog.of({ begin, finish, find, recent, latest });
});

export const layer = Layer.effect(RuntimeLog, make);
