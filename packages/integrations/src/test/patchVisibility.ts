import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as PatchVisibility from "../PatchVisibility.js";

/**
 * Patches' decision of which patches a person can open, as a stand-in: everyone opens every patch
 * their company stores, so a call from a patch with no row stays hidden. Patches owns and tests
 * the real one.
 */
export const layer = Layer.effect(
  PatchVisibility.PatchVisibility,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return PatchVisibility.PatchVisibility.of({
      openableIds: (companyId) =>
        Effect.map(
          sql<{ readonly id: string }>`SELECT id FROM patches WHERE company_id = ${companyId}`,
          (rows) => rows.map((row) => row.id)
        )
    });
  })
);
