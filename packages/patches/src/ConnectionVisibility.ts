import { Teams } from "@patchy/companies";
import { PatchVisibility } from "@patchy/integrations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Audiences from "./Audiences.js";

/** Which of a company's patches one member can open, by the same rule as patch reads. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const teams = yield* Teams.Teams;
  const rows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      id: Schema.String,
      scope: Schema.Literals(["company", "public", "teams"]),
      teamIds: Schema.Array(Schema.String)
    }),
    execute: (companyId) => sql`SELECT p.id, p.scope,
      ARRAY(SELECT team_id FROM patch_audience_teams WHERE patch_id = p.id) AS "teamIds"
      FROM patches p WHERE p.company_id = ${companyId} AND p.disabled_at IS NULL`
  });
  return PatchVisibility.PatchVisibility.of({
    openableIds: Effect.fn("ConnectionVisibility.openableIds")(
      function* (companyId: string, userId: string) {
        const [person] = yield* teams.people(companyId, [userId]);
        if (person === undefined) return [];
        return (yield* rows(companyId))
          .filter((row) => Audiences.admits(Audiences.stored(row.scope, row.teamIds), person))
          .map((row) => row.id);
      },
      Effect.catchTags({ SchemaError: Effect.die })
    )
  });
});
export const layer = Layer.effect(PatchVisibility.PatchVisibility, make);
