import * as Effect from "effect/Effect";
import * as CompanyDatabases from "./CompanyDatabases.js";
import { namespace, quoteIdentifier } from "./Inventory.js";

/** Only reclaim after confirming that the platform row is gone. */
export const reclaimNamespace = Effect.fn("Reclamation.reclaimNamespace")(function* () {
  const { patchId, sql, resources } = yield* CompanyDatabases.PatchLock;
  const name = namespace(patchId);
  const touched = yield* sql<{ key: string }>`UPDATE patchy.tables
    SET resource_revision = resource_revision + 1 WHERE patch_id = ${patchId}
    RETURNING 'table:' || patch_id || ':' || name AS key`;
  const stores = yield* sql<{ key: string }>`UPDATE patchy.stores
    SET resource_revision = resource_revision + 1 WHERE patch_id = ${patchId}
    RETURNING 'store:' || patch_id || ':' || name AS key`;
  for (const row of [...touched, ...stores]) resources.add(row.key);
  yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(name)} CASCADE`);
  yield* sql`DELETE FROM patchy.patches WHERE patch_id = ${patchId}`;
  yield* sql`DELETE FROM patchy.orphan_namespaces WHERE namespace = ${name}`;
});
