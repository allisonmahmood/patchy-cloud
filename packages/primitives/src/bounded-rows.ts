import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { Runtime } from "@patchy/runtime/core";

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
      hasMore: Schema.Boolean,
      exceeded: Schema.Boolean
    })
  )
);
// The database gates the payload, not the driver: PGlite materializes complete query results.
// __position is assigned using the original SQL ordering, before projecting timestamps to text.
export const boundedRows = Effect.fn("Primitives.boundedRows")(function* (
  sql: SqlClient.SqlClient,
  query: string,
  values: ReadonlyArray<unknown>,
  pageSize: number,
  maxBytes: number
) {
  const page = `$${values.length + 1}`;
  const budget = `$${values.length + 2}`;
  const envelopes = yield* sql
    .unsafe(
      `WITH "__selected" AS MATERIALIZED (${query}),
      "__encoded" AS MATERIALIZED (
        SELECT "__position", (to_jsonb("__selected") - '__position')::text AS "__row"
        FROM "__selected" WHERE "__position" <= ${page}
      ),
      "__budget" AS (
        SELECT COALESCE(sum(octet_length("__row") + 1), 0) + 2 > ${budget} AS exceeded
        FROM "__encoded"
      )
      SELECT COALESCE((
        SELECT json_agg("__row"::json ORDER BY "__position")
        FROM "__encoded" WHERE NOT "__budget".exceeded
      ), '[]'::json) AS rows,
      EXISTS (SELECT 1 FROM "__selected" WHERE "__position" > ${page}) AS "hasMore",
      exceeded FROM "__budget"`,
      [...values, pageSize, maxBytes]
    )
    .pipe(Effect.map(decodeEnvelope));
  const envelope = envelopes[0]!;
  if (envelope.exceeded) return yield* new Runtime.TooLarge({ maxBytes });
  return envelope;
});
