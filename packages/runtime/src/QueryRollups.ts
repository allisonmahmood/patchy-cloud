import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface Record {
  readonly runId: string;
  readonly companyId: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly handler: string;
  readonly startedAt: number;
  readonly reRun: boolean;
  readonly failures: number;
  readonly guestMs: number;
  readonly dbMs: number;
  readonly callbacks: number;
  readonly argsBytes: number;
  readonly resultBytes: number;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const record = Effect.fn("QueryRollups.record")(function* (input: Record) {
    // Only the transaction that inserts this run id may add its counters.
    // A retry after a lost commit acknowledgement therefore adds nothing.
    yield* sql`
        WITH inserted AS (
          INSERT INTO runtime_query_rollup_runs (run_id, applied_at)
          VALUES (${input.runId}, statement_timestamp())
          ON CONFLICT (run_id) DO NOTHING
          RETURNING run_id
        )
        INSERT INTO runtime_query_rollups (
          company_id, patch_id, version_id, handler, minute, runs, re_runs,
          failures, guest_ms, db_ms, callbacks, args_bytes, result_bytes
        )
        SELECT ${input.companyId}, ${input.patchId}, ${input.versionId}, ${input.handler},
          to_timestamp(${Math.floor(input.startedAt / 60_000) * 60}), 1,
          ${input.reRun ? 1 : 0}, ${input.failures}, ${input.guestMs}, ${input.dbMs},
          ${input.callbacks}, ${input.argsBytes}, ${input.resultBytes}
        FROM inserted
        ON CONFLICT (company_id, patch_id, version_id, handler, minute)
        DO UPDATE SET
          runs = runtime_query_rollups.runs + EXCLUDED.runs,
          re_runs = runtime_query_rollups.re_runs + EXCLUDED.re_runs,
          failures = runtime_query_rollups.failures + EXCLUDED.failures,
          guest_ms = runtime_query_rollups.guest_ms + EXCLUDED.guest_ms,
          db_ms = runtime_query_rollups.db_ms + EXCLUDED.db_ms,
          callbacks = runtime_query_rollups.callbacks + EXCLUDED.callbacks,
          args_bytes = runtime_query_rollups.args_bytes + EXCLUDED.args_bytes,
          result_bytes = runtime_query_rollups.result_bytes + EXCLUDED.result_bytes`;
    // Retention follows persistence time, not the invocation's start minute.
    yield* sql`
        DELETE FROM runtime_query_rollup_runs
        WHERE applied_at < statement_timestamp() - INTERVAL '1 hour'`;
  }, sql.withTransaction);

  return { record };
});
