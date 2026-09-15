import * as Effect from "effect/Effect";
import * as CompanyDatabases from "./CompanyDatabases.js";
import { namespace, quoteIdentifier } from "./Inventory.js";

/** Only reclaim after confirming that the platform row is gone. */
export const reclaimNamespace = Effect.fn("Reclamation.reclaimNamespace")(function* () {
  const { patchId, sql } = yield* CompanyDatabases.PatchLock;
  const name = namespace(patchId);
  yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(name)} CASCADE`);
  yield* sql`DELETE FROM patchy.patches WHERE patch_id = ${patchId}`;
  yield* sql`DELETE FROM patchy.orphan_namespaces WHERE namespace = ${name}`;
});
