import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ActiveMembers from "../ActiveMembers.js";

/**
 * Companies' count of active members, read from the migrated platform database as the server's
 * wiring reads it, for fleet cases that add, deactivate and reactivate users.
 */
export const layer = Layer.effect(
  ActiveMembers.ActiveMembers,
  Effect.map(SqlClient.SqlClient, (sql) =>
    ActiveMembers.ActiveMembers.of({
      count: (companyId) =>
        sql<{ readonly count: number }>`SELECT count(*)::integer AS count FROM users
          WHERE company_id = ${companyId} AND deactivated_at IS NULL`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0)
        )
    })
  )
);
