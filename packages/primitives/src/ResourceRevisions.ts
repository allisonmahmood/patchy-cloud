import { CompanyDatabases } from "@patchy/company-database";
import { Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export const RevisionRow = Schema.Struct({ key: Schema.String, revision: Schema.String });
const find = SqlSchema.findAll({
  Request: Schema.Array(Schema.String),
  Result: RevisionRow,
  execute: Effect.fn("ResourceRevisions.find")(function* (keys) {
    const sql = yield* CompanyDatabases.CompanyConnection;
    return yield* sql`SELECT 'table:' || patch_id || ':' || name AS key,
        resource_revision::text AS revision FROM patchy.tables
      WHERE ('table:' || patch_id || ':' || name) IN ${sql.in(keys)}
      UNION ALL
      SELECT 'store:' || patch_id || ':' || name AS key,
        resource_revision::text AS revision FROM patchy.stores
      WHERE ('store:' || patch_id || ':' || name) IN ${sql.in(keys)}`;
  })
});

/** Empty key sets have no storage dependencies and do not establish a SQL snapshot. */
export const read = Effect.fn("ResourceRevisions.read")(function* (keys: readonly string[]) {
  if (keys.length === 0) return {};
  const vector: Record<string, string> = Object.fromEntries(keys.map((key) => [key, "-1"]));
  const rows = yield* find(keys).pipe(
    Effect.catchTags({ SchemaError: Effect.die }),
    Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
  );
  for (const row of rows) vector[row.key] = row.revision;
  return vector;
});
