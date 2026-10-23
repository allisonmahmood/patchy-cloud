import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- a setup link needs cryptographic randomness; Effect Random is not a CSPRNG.
import { randomBytes } from "node:crypto";
import * as SqlClient from "effect/sql/SqlClient";
import { randomToken } from "@patchy/core";

/**
 * Setup links: the `?s=<value>` in the Final step panel's setup line, which lets the person's own
 * panel follow the agent that fetched it. A value is 128 random bits, one live per person for 30
 * minutes, kept across reloads. It is not a credential: holding it can only stamp "picked up" and
 * start a login that shows as pending on its owner's panel. Its value never leaves Patchy;
 * events carry the separate `setupId`.
 */
const lifetime = "30 minutes";
const valueShape = /^[a-z2-7]{26}$/u;
const base32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 128 random bits as 26 lowercase base32 characters: easy to read aloud, safe in any URL. */
const newValue = () => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of randomBytes(16)) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += base32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + base32[(value << (5 - bits)) & 31] : out;
};

/** A value as the line carries it, or null for anything that can't be one. */
export const parse = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && valueShape.test(value) ? value : null;

/** What became of the login the line started, kept because device logins are deleted. */
export const Outcome = Schema.Literals([
  "pending",
  "denied",
  "expired",
  "contested",
  "connected",
  "other_account"
]);
export type Outcome = typeof Outcome.Type;

const Link = Schema.Struct({
  value: Schema.String,
  setupId: Schema.String,
  created: Schema.Boolean
});
const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(Link));

/** The person's live line, made when they have none. `created` says this call made it. */
export const current = Effect.fn("SetupLinks.current")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // The person's row lock keeps two loads of the panel from making two lines.
      yield* sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      // A line a login still names waits for that login's cleanup: deleting it here would lock
      // the login after the line, the reverse of every login path.
      yield* sql`DELETE FROM setup_links l
        WHERE l.user_id = ${userId} AND l.expires_at < now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM device_logins d WHERE d.setup_link_id = l.id)`;
      const live = yield* sql`
        SELECT id AS value, analytics_id AS "setupId", false AS created FROM setup_links
        WHERE user_id = ${userId} AND retired_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`;
      const made =
        live.length > 0
          ? live
          : yield* sql`
              INSERT INTO setup_links (id, analytics_id, user_id, expires_at)
              VALUES (${newValue()}, ${randomToken(12)}, ${userId},
                clock_timestamp() + ${lifetime}::interval)
              RETURNING id AS value, analytics_id AS "setupId", true AS created`;
      const [link] = yield* decodeLinks(made).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      return link!;
    })
  );
});

/** Get a new line: the live one retires, and the panel's next render makes a fresh one. */
export const retire = Effect.fn("SetupLinks.retire")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE setup_links SET retired_at = clock_timestamp()
    WHERE user_id = ${userId} AND retired_at IS NULL`;
});

const decodePickup = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      companyId: Schema.String,
      setupId: Schema.String,
      first: Schema.Boolean
    })
  )
);

/** An agent fetched the line's llms.txt: stamps "picked up" on a live line, once. */
export const pickUp = Effect.fn("SetupLinks.pickUp")(function* (value: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    WITH found AS (
      SELECT id, picked_up_at IS NULL AS first FROM setup_links
      WHERE id = ${value} AND retired_at IS NULL AND expires_at > now() FOR UPDATE
    )
    UPDATE setup_links l SET picked_up_at = COALESCE(l.picked_up_at, clock_timestamp())
    FROM found, users u WHERE l.id = found.id AND u.id = l.user_id
    RETURNING l.user_id AS "userId", u.company_id AS "companyId", l.analytics_id AS "setupId",
      found.first`;
  const [row] = yield* decodePickup(rows).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  return Option.fromNullishOr(row);
});

const decodeBind = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ bound: Schema.Boolean }))
);

/**
 * A device login starting with a live line: the first binds and is pending; any later one marks
 * the line contested and proceeds as an ordinary login. Runs inside the start's transaction.
 */
export const bind = Effect.fn("SetupLinks.bind")(function* (value: string, userCode: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    WITH found AS (
      SELECT id, user_code IS NULL AS free FROM setup_links
      WHERE id = ${value} AND retired_at IS NULL AND expires_at > now() FOR UPDATE
    )
    UPDATE setup_links l SET
      user_code = CASE WHEN found.free THEN ${userCode} ELSE l.user_code END,
      outcome = CASE WHEN found.free THEN 'pending'
        WHEN l.outcome IN ('connected', 'other_account') THEN l.outcome ELSE 'contested' END
    FROM found WHERE l.id = found.id
    RETURNING found.free AS bound`;
  const [row] = yield* decodeBind(rows).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  return row?.bound === true;
});

/**
 * Bound logins that ran out before an answer: their lines end expired, written before the logins
 * are deleted. Runs inside the purge's or the poll's transaction.
 */
export const expired = Effect.fn("SetupLinks.expired")(function* (linkIds: ReadonlyArray<string>) {
  if (linkIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE setup_links SET outcome = 'expired'
    WHERE id IN ${sql.in(linkIds)} AND outcome = 'pending'`;
});

/** The bound login was denied. */
export const denied = Effect.fn("SetupLinks.denied")(function* (linkId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE setup_links SET outcome = 'denied'
    WHERE id = ${linkId} AND outcome = 'pending'`;
});

const decodeMinted = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ setupId: Schema.String }))
);

/**
 * The bound login's key was minted, inside the mint's transaction. The key and who confirmed it are
 * always recorded and the setup id always answered, so analytics join up even for a contested
 * line. Only a pending outcome moves: connected when its owner confirmed, confirmed by another
 * account otherwise, and expired when the line ran out first.
 */
export const minted = Effect.fn("SetupLinks.minted")(function* (input: {
  readonly linkId: string;
  readonly tokenId: string;
  readonly userId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    UPDATE setup_links SET machine_token_id = ${input.tokenId}, confirmed_by = ${input.userId},
      outcome = CASE
        WHEN outcome <> 'pending' THEN outcome
        WHEN expires_at <= now() THEN 'expired'
        WHEN user_id = ${input.userId} THEN 'connected'
        ELSE 'other_account' END
    WHERE id = ${input.linkId}
    RETURNING analytics_id AS "setupId"`;
  const [row] = yield* decodeMinted(rows).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  return Option.fromNullishOr(row?.setupId);
});

/** What the person's newest line says, for their panel. */
export const Status = Schema.Struct({
  value: Schema.String,
  live: Schema.Boolean,
  pickedUp: Schema.Boolean,
  outcome: Schema.NullOr(Outcome),
  /** The bound device login's state while it exists; null once it completed, expired or went. */
  loginState: Schema.NullOr(Schema.Literals(["pending", "confirmed", "denied"])),
  machineTokenId: Schema.NullOr(Schema.String),
  /** When the bound login runs out, on the app's clock like the login itself. */
  loginExpiresAt: Schema.NullOr(Schema.Date),
  /** The bound login, for confirming it in the panel: its code, the computer's name hint, and the
   * name of the person's own key it would replace. */
  userCode: Schema.NullOr(Schema.String),
  machineNameHint: Schema.NullOr(Schema.String),
  oldMachineName: Schema.NullOr(Schema.String)
});
export type Status = typeof Status.Type;
const decodeStatus = Schema.decodeUnknownEffect(Schema.Array(Status));

export const status = Effect.fn("SetupLinks.status")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT l.id AS value, l.expires_at > now() AS live, l.picked_up_at IS NOT NULL AS "pickedUp",
      l.outcome, d.state AS "loginState", l.machine_token_id AS "machineTokenId",
      d.expires_at AS "loginExpiresAt",
      d.user_code AS "userCode", d.machine_name_hint AS "machineNameHint", t.name AS "oldMachineName"
    FROM setup_links l
    LEFT JOIN device_logins d ON d.setup_link_id = l.id AND d.user_code = l.user_code
    LEFT JOIN machine_tokens t ON t.id = d.old_token_id AND t.user_id = l.user_id
    WHERE l.user_id = ${userId} AND l.retired_at IS NULL
    ORDER BY l.created_at DESC LIMIT 1`;
  const [row] = yield* decodeStatus(rows).pipe(Effect.catchTags({ SchemaError: Effect.die }));
  return Option.fromNullishOr(row);
});
