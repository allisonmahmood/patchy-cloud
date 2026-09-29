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

const encodeLogLines = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)));

export class InvocationLog extends Context.Service<
  InvocationLog,
  {
    readonly begin: (input: Begin) => Effect.Effect<string, SqlError>;
    readonly finish: (input: Finish) => Effect.Effect<void, SqlError>;
    readonly find: (input: {
      readonly companyId: string;
      readonly invocationId: string;
    }) => Effect.Effect<Invocation | null, SqlError>;
  }
>()("@patchy/runtime/InvocationLog") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const findInvocation = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, invocationId: Schema.String }),
    Result: Invocation,
    execute: ({ companyId, invocationId }) => sql`
      SELECT id, company_id AS "companyId", patch_id AS "patchId", version_id AS "versionId",
        handler, kind, initiating_viewer_id AS "initiatingViewerId",
        effective_principal AS "effectivePrincipal", parent_id AS "parentId", outcome,
        outcome_code AS "outcomeCode", correlation_id AS "correlationId",
        started_at AS "startedAt", deadline, settled_at AS "settledAt",
        duration_ms AS "durationMs", guest_ms AS "guestMs", db_ms AS "dbMs", callbacks,
        args_bytes AS "argsBytes", result_bytes AS "resultBytes", attempts,
        log_lines AS "logLines", reply_delivered AS "replyDelivered"
      FROM runtime_invocations
      WHERE company_id = ${companyId} AND id = ${invocationId}`
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
      UPDATE runtime_invocations SET outcome = ${input.outcome}, outcome_code = ${input.outcomeCode},
        settled_at = to_timestamp(${input.settledAt / 1_000}), duration_ms = ${input.durationMs},
        guest_ms = ${input.guestMs}, db_ms = ${input.dbMs}, callbacks = ${input.callbacks},
        result_bytes = ${input.resultBytes}, attempts = ${input.attempts},
        log_lines = ${encodeLogLines(input.logLines)}::jsonb, reply_delivered = ${input.replyDelivered}
      WHERE id = ${input.id}
        AND (outcome = 'pending'
          OR (outcome = 'unknown_outcome'
            AND ${input.outcome} IN ('success', 'handler_error', 'failure')))`;
  });

  const find = Effect.fn("InvocationLog.find")(function* (
    input: Parameters<InvocationLog["Service"]["find"]>[0]
  ) {
    const row = yield* findInvocation(input).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    return Option.getOrNull(row);
  });

  return InvocationLog.of({ begin, finish, find });
});

export const layer = Layer.effect(InvocationLog, make);
