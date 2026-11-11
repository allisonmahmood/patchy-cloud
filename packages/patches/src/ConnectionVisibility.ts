import { Teams } from "@patchy/companies";
import { PatchVisibility } from "@patchy/integrations";
import { SharingScope } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Audiences from "./Audiences.js";

/** Batched patch metadata admission, using the same decision as patch reads. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const teams = yield* Teams.Teams;
  const rows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, patchIds: Schema.Array(Schema.String) }),
    Result: Schema.Struct({
      id: Schema.String,
      companyId: Schema.String,
      scope: SharingScope,
      disabledAt: Schema.NullOr(Schema.String),
      teamIds: Schema.Array(Schema.String)
    }),
    execute: ({ companyId, patchIds }) => sql`SELECT p.id, p.company_id AS "companyId", p.scope,
      p.disabled_at::text AS "disabledAt", ARRAY(SELECT team_id FROM patch_audience_teams WHERE patch_id = p.id) AS "teamIds"
      FROM patches p WHERE p.company_id = ${companyId} AND ${sql.in("p.id", patchIds)}`
  });
  return PatchVisibility.PatchVisibility.of({
    visibleIds: Effect.fn("ConnectionVisibility.visibleIds")(
      function* (companyId, userId, patchIds) {
        if (patchIds.length === 0) return new Set<string>();
        const admitted = yield* Audiences.forPatches(companyId, userId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Teams.Teams, teams)
        );
        const patches = yield* rows({ companyId, patchIds });
        return new Set(
          patches
            .filter((row) =>
              admitted({
                ...row,
                audience: {
                  members:
                    row.scope === "teams"
                      ? { kind: "teams", teamIds: row.teamIds }
                      : { kind: row.scope }
                }
              })
            )
            .map((row) => row.id)
        );
      },
      Effect.catchTags({ SchemaError: Effect.die })
    )
  });
});
export const layer = Layer.effect(PatchVisibility.PatchVisibility, make).pipe(
  Layer.provide(Teams.layer)
);
