/**
 * PROTOTYPE for #119 — throwaway, delete with the branch. The one database
 * read the login door makes per page load: the Clerk user id to a Patchy
 * user row in the `prototype_users` table (migration `0090_prototype_users`),
 * joined to its company. Every signed-in person the prototype has not seen
 * before joins the seeded dev company `acct_dev` just in time, unless the
 * address says `+other` (lane R2-6's second company, `acct_other`); the door
 * keeps `+outsider` addresses out before it gets here. `find` is timed because
 * the read's cost is one of the prototype's answers.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/** The seeded dev company every prototype user joins (`scripts/dev/src/seed.ts`). */
export const DEV_ACCOUNT_ID = "acct_dev";

/**
 * The second company lane R2-6 inserted by hand, so the door has someone who
 * is signed in, known, and from the wrong company for `acct_dev`'s patches.
 */
export const OTHER_ACCOUNT_ID = "acct_other";

/** Which company a just-in-time user joins: `+other` addresses land in the second one. */
export const accountIdFor = (email: string): string =>
  email.includes("+other") ? OTHER_ACCOUNT_ID : DEV_ACCOUNT_ID;

export class PrototypeUser extends Schema.Class<PrototypeUser>("PrototypeUser")({
  clerkUserId: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String)
}) {}

export interface Found {
  readonly user: Option.Option<PrototypeUser>;
  /** Wall-clock milliseconds the SELECT took. */
  readonly dbMs: number;
}

export class PrototypeUsers extends Context.Service<
  PrototypeUsers,
  {
    readonly find: (clerkUserId: string) => Effect.Effect<Found, SqlError>;
    readonly createJustInTime: (input: {
      readonly clerkUserId: string;
      readonly email: string;
      readonly name: string | null;
    }) => Effect.Effect<PrototypeUser, SqlError>;
  }
>()("@patchy/auth/PrototypeUsers.prototype/PrototypeUsers") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: PrototypeUser,
    execute: (clerkUserId) => sql`
      SELECT u.clerk_user_id AS "clerkUserId", u.account_id AS "accountId",
             a.name AS "accountName", u.email, u.name
      FROM prototype_users u JOIN accounts a ON a.id = u.account_id
      WHERE u.clerk_user_id = ${clerkUserId}`
  });

  const find = Effect.fn("PrototypeUsers.find")(function* (clerkUserId: string) {
    const [duration, user] = yield* Effect.timed(
      findRow(clerkUserId).pipe(Effect.catchTags({ SchemaError: Effect.die }))
    );
    return { user, dbMs: Duration.toMillis(duration) } satisfies Found;
  });

  const createJustInTime = Effect.fn("PrototypeUsers.createJustInTime")(function* (input: {
    readonly clerkUserId: string;
    readonly email: string;
    readonly name: string | null;
  }) {
    yield* sql`
      INSERT INTO prototype_users (clerk_user_id, account_id, email, name)
      VALUES (${input.clerkUserId}, ${accountIdFor(input.email)}, ${input.email}, ${input.name})
      ON CONFLICT (clerk_user_id) DO NOTHING`;
    const { user } = yield* find(input.clerkUserId);
    // Just inserted (or already there): absence here is a bug, not a state.
    return Option.getOrThrow(user);
  });

  return PrototypeUsers.of({ find, createJustInTime });
});

export const layer = Layer.effect(PrototypeUsers, make);
