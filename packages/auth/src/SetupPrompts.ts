import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When Home shows the Final step panel to someone with no live machine token: at every sign-in
 * during their first week, or for their first three sign-ins that reach Home, whichever lasts
 * longer, unless they pressed Later in this sign-in. A sign-in is a Clerk session id. Rows are
 * kept only for the first four sign-ins and any during the first week, so someone who connected
 * and later revoked every key never re-enters the window. The database's clock decides.
 */
const firstSignIns = 3;
const kept = 4;

const decodeSeen = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ show: Schema.Boolean }))
);

/** Records that this sign-in reached Home, and answers whether the panel shows for it. */
export const seen = Effect.fn("SetupPrompts.seen")(function* (userId: string, sid: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Two sign-ins racing past the cap at once can keep a fifth row; the first three are still
      // the first three, so Home takes no lock on every visit.
      yield* sql`
        INSERT INTO setup_prompt_sign_ins (user_id, sid)
        SELECT ${userId}, ${sid}
        WHERE (SELECT created_at > now() - interval '7 days' FROM users WHERE id = ${userId})
          OR (SELECT count(*) FROM setup_prompt_sign_ins WHERE user_id = ${userId}) < ${kept}
        ON CONFLICT DO NOTHING`;
      // No row for this sign-in means the window closed for good, so nothing comes back.
      const rows = yield* sql`
        SELECT s.later_at IS NULL AND (
          u.created_at > now() - interval '7 days'
          OR (SELECT count(*) FROM setup_prompt_sign_ins e
              WHERE e.user_id = s.user_id AND (e.first_seen_at, e.sid) < (s.first_seen_at, s.sid))
            < ${firstSignIns}
        ) AS show
        FROM setup_prompt_sign_ins s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ${userId} AND s.sid = ${sid}`;
      const [row] = yield* decodeSeen(rows).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      return row?.show === true;
    })
  );
});

/** Later: the panel stays away for the rest of this sign-in. */
export const later = Effect.fn("SetupPrompts.later")(function* (userId: string, sid: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE setup_prompt_sign_ins SET later_at = COALESCE(later_at, clock_timestamp())
    WHERE user_id = ${userId} AND sid = ${sid}`;
});
