import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { newInternalId } from "@patchy/core";

const MUTATION_DEADLINE_MS = 30_000;
const MAX_SQL_BYTES = 8_192;
const encoder = new TextEncoder();

export interface Begin {
  readonly companyId: string;
  readonly patchId: string | null;
  readonly versionId: string | null;
  readonly userId: string;
  readonly credentialKind: "session" | "admin";
  readonly op: string;
  readonly resource: string | null;
  readonly connectionId: string | null;
  readonly correlationId: string;
  readonly sql?: string;
  /** Elapsed time from begin, including an integration's queue time. */
  readonly deadlineMs?: number;
}

export class Call extends Schema.Class<Call>("RuntimeLog.Call")({
  id: Schema.String,
  at: Schema.Date,
  companyId: Schema.String,
  patchId: Schema.NullOr(Schema.String),
  versionId: Schema.NullOr(Schema.String),
  userId: Schema.String,
  credentialKind: Schema.Literals(["session", "admin"]),
  op: Schema.String,
  resource: Schema.NullOr(Schema.String),
  connectionId: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["pending", "unknown", "success", "failure"]),
  durationMs: Schema.NullOr(Schema.Int),
  rowCount: Schema.NullOr(Schema.Int),
  sql: Schema.NullOr(Schema.String),
  correlationId: Schema.String,
  deadlineMs: Schema.Int
}) {}

export class RuntimeLog extends Context.Service<
  RuntimeLog,
  {
    readonly begin: (input: Begin) => Effect.Effect<string, SqlError>;
    readonly finish: (input: {
      readonly correlationId: string;
      readonly outcome: "success" | "failure";
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
  }
>()("@patchy/runtime/RuntimeLog") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (now: number) => sql`
    id, at, company_id AS "companyId", patch_id AS "patchId", version_id AS "versionId",
    user_id AS "userId", credential_kind AS "credentialKind", op, resource,
    connection_id AS "connectionId",
    CASE WHEN outcome = 'pending'
      AND at + deadline_ms * interval '1 millisecond' < to_timestamp(${now / 1_000})
      THEN 'unknown' ELSE outcome END AS outcome,
    duration_ms AS "durationMs", row_count AS "rowCount", sql,
    correlation_id AS "correlationId", deadline_ms AS "deadlineMs"`;
  const findCall = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      correlationId: Schema.String,
      now: Schema.Number
    }),
    Result: Call,
    execute: ({ companyId, correlationId, now }) => sql`
      SELECT ${columns(now)} FROM runtime_calls
      WHERE company_id = ${companyId} AND correlation_id = ${correlationId}`
  });
  const recentCalls = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      connectionId: Schema.String,
      limit: Schema.Number,
      now: Schema.Number
    }),
    Result: Call,
    execute: ({ companyId, connectionId, limit, now }) => sql`
      SELECT ${columns(now)} FROM runtime_calls
      WHERE company_id = ${companyId} AND connection_id = ${connectionId}
      ORDER BY at DESC, id DESC LIMIT ${limit}`
  });

  const begin = Effect.fn("RuntimeLog.begin")(function* (input: Begin) {
    const now = yield* Clock.currentTimeMillis;
    const id = newInternalId("call");
    let query: string | null = null;
    if (input.op === "postgres.query" && input.sql !== undefined) {
      // encodeInto stops before a partial UTF-8 code point without allocating
      // the whole query. The prefix is audit text, never executable SQL.
      const { read } = encoder.encodeInto(input.sql, new Uint8Array(MAX_SQL_BYTES));
      query = input.sql.slice(0, read);
    }
    yield* sql`
      INSERT INTO runtime_calls (id, at, company_id, patch_id, version_id, user_id,
        credential_kind, op, resource, connection_id, correlation_id, deadline_ms, sql)
      VALUES (${id}, to_timestamp(${now / 1_000}), ${input.companyId}, ${input.patchId},
        ${input.versionId}, ${input.userId}, ${input.credentialKind}, ${input.op},
        ${input.resource}, ${input.connectionId}, ${input.correlationId},
        ${input.deadlineMs ?? MUTATION_DEADLINE_MS}, ${query})`;
    return id;
  });

  const finish = Effect.fn("RuntimeLog.finish")(function* (
    input: Parameters<RuntimeLog["Service"]["finish"]>[0]
  ) {
    yield* sql`
      UPDATE runtime_calls SET outcome = ${input.outcome}, duration_ms = ${input.durationMs},
        row_count = ${input.rowCount}
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
      limit: input.limit ?? 100,
      now: yield* Clock.currentTimeMillis
    }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  });

  return RuntimeLog.of({ begin, finish, find, recent });
});

export const layer = Layer.effect(RuntimeLog, make);
