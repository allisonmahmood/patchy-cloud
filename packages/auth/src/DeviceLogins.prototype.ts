/**
 * PROTOTYPE for #131 — throwaway, delete with the branch. Device logins: the
 * row a `patchy login` opens, the user code the person confirms on
 * `/login/device`, and the poll that hands the machine token to the CLI
 * exactly once. The device code is stored as a hash; the user code is the
 * page's lookup key. A confirmed login keeps the plaintext token until the
 * poll that reports it deletes the row — a prototype shortcut, so the token
 * can be minted in confirm's transaction and still leave through the poll.
 *
 * The machine token is an ordinary `api_tokens` row on the user's company
 * account (the prototype has no user-owned tokens), named by the person on
 * the confirm page, `upload` scope. A re-login sends the previous token id:
 * the page prefills its name and confirm revokes it in the same transaction,
 * unless it belongs to another account, in which case it is ignored (#122 Q4).
 */
// @effect-diagnostics globalDateInEffect:off -- prototype: the row's expiry is a Date because the row decoder hands Dates back.
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { newInternalId, randomToken, sha256 } from "@patchy/core";
import * as Tokens from "./Tokens.js";

/** RFC 8628 §6.1's confusable-free alphabet, eight characters as `XXXX-XXXX`. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const POLL_INTERVAL_SECONDS = 5;

/** Ten minutes, overridable so the prototype's expiry run does not take ten minutes. */
export const ttlSeconds = Config.int("PROTOTYPE_DEVICE_LOGIN_TTL_SECONDS").pipe(
  Config.withDefault(600)
);

/** `wxyz4rt9`, `WXYZ 4RT9`, `wxyz-4rt9` all read as `WXYZ-4RT9`; anything else is not a code. */
export const normalizeUserCode = (raw: string): string | undefined => {
  const letters = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : undefined;
};

const userCode = () => {
  const bytes = randomToken(8);
  let out = "";
  for (let index = 0; index < 8; index += 1) {
    const at = bytes.charCodeAt(index) % USER_CODE_ALPHABET.length;
    out += USER_CODE_ALPHABET[at];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
};

/** What the confirm page finds for a user code. */
export type Lookup =
  | {
      readonly _tag: "pending";
      readonly userCode: string;
      readonly machineNameHint: string | null;
      readonly previousToken: {
        readonly id: string;
        readonly name: string;
        readonly accountId: string;
      } | null;
      readonly expiresAt: Date;
    }
  | { readonly _tag: "expired" }
  | { readonly _tag: "answered"; readonly status: "confirmed" | "denied" }
  | { readonly _tag: "unknown" };

export type Poll =
  | { readonly _tag: "pending"; readonly slowDown: boolean; readonly expiresAt: Date }
  | {
      readonly _tag: "complete";
      readonly token: string;
      readonly machine: { readonly id: string; readonly name: string };
      readonly accountId: string;
      readonly accountName: string;
    }
  | { readonly _tag: "gone"; readonly code: "expired" | "denied" | "unknown" };

export class DeviceLogins extends Context.Service<
  DeviceLogins,
  {
    readonly start: (input: {
      readonly machineName: string | null;
      readonly previousTokenId: string | null;
    }) => Effect.Effect<{ deviceCode: string; userCode: string; expiresAt: Date }, SqlError>;
    readonly lookup: (userCode: string) => Effect.Effect<Lookup, SqlError>;
    /** `None` when the code is no longer pending: someone else answered it, or it expired. */
    readonly confirm: (input: {
      readonly userCode: string;
      readonly accountId: string;
      readonly machineName: string;
      readonly confirmedBy: string;
    }) => Effect.Effect<Option.Option<{ id: string; name: string }>, SqlError>;
    readonly deny: (userCode: string) => Effect.Effect<boolean, SqlError>;
    readonly poll: (deviceCode: string) => Effect.Effect<Poll, SqlError>;
  }
>()("@patchy/auth/DeviceLogins.prototype/DeviceLogins") {}

class Row extends Schema.Class<Row>("DeviceLoginRow")({
  id: Schema.String,
  userCode: Schema.String,
  machineName: Schema.NullOr(Schema.String),
  previousTokenId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "confirmed", "denied"]),
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  apiTokenId: Schema.NullOr(Schema.String),
  apiTokenName: Schema.NullOr(Schema.String),
  tokenPlaintext: Schema.NullOr(Schema.String),
  expiresAt: Schema.Date,
  lastPolledAt: Schema.NullOr(Schema.Date)
}) {}

class PreviousToken extends Schema.Class<PreviousToken>("PreviousToken")({
  id: Schema.String,
  name: Schema.String,
  accountId: Schema.String
}) {}

const dieOnSchemaError = { SchemaError: Effect.die } as const;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* Tokens.Tokens;
  const ttl = yield* ttlSeconds;

  const rowColumns = sql`
    l.id, l.user_code AS "userCode", l.machine_name AS "machineName",
    l.previous_token_id AS "previousTokenId", l.status, l.account_id AS "accountId",
    a.name AS "accountName", l.api_token_id AS "apiTokenId", t.name AS "apiTokenName",
    l.token_plaintext AS "tokenPlaintext", l.expires_at AS "expiresAt",
    l.last_polled_at AS "lastPolledAt"`;

  const byUserCode = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Row,
    execute: (code) => sql`
      SELECT ${rowColumns} FROM prototype_device_logins l
      LEFT JOIN accounts a ON a.id = l.account_id
      LEFT JOIN api_tokens t ON t.id = l.api_token_id
      WHERE l.user_code = ${code} FOR UPDATE OF l`
  });

  const byDeviceCodeHash = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Row,
    execute: (hash) => sql`
      SELECT ${rowColumns} FROM prototype_device_logins l
      LEFT JOIN accounts a ON a.id = l.account_id
      LEFT JOIN api_tokens t ON t.id = l.api_token_id
      WHERE l.device_code_hash = ${hash} FOR UPDATE OF l`
  });

  const previousToken = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: PreviousToken,
    execute: (id) =>
      sql`SELECT id, name, account_id AS "accountId" FROM api_tokens WHERE id = ${id}`
  });

  const remove = (id: string) => sql`DELETE FROM prototype_device_logins WHERE id = ${id}`;

  const start = Effect.fn("DeviceLogins.start")(function* (input: {
    readonly machineName: string | null;
    readonly previousTokenId: string | null;
  }) {
    const now = yield* Clock.currentTimeMillis;
    // Rows nobody polled and nobody will: an hour past expiry is long enough
    // for every poll that was going to report them.
    yield* sql`
      DELETE FROM prototype_device_logins
      WHERE expires_at < to_timestamp(${(now - 3_600_000) / 1_000})`;
    const deviceCode = `dc_${randomToken(32)}`;
    const code = userCode();
    const expiresAt = new Date(now + ttl * 1_000);
    yield* sql`
      INSERT INTO prototype_device_logins
        (id, device_code_hash, user_code, machine_name, previous_token_id, expires_at)
      VALUES (${newInternalId("dl")}, ${sha256(deviceCode)}, ${code}, ${input.machineName},
              ${input.previousTokenId}, ${expiresAt})`;
    return { deviceCode, userCode: code, expiresAt };
  });

  const lookup = Effect.fn("DeviceLogins.lookup")(function* (code: string) {
    const now = yield* Clock.currentTimeMillis;
    const row = yield* byUserCode(code).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(row)) return { _tag: "unknown" } as const;
    const { value } = row;
    if (value.status !== "pending") return { _tag: "answered", status: value.status } as const;
    if (value.expiresAt.getTime() <= now) return { _tag: "expired" } as const;
    const previous =
      value.previousTokenId === null
        ? Option.none<PreviousToken>()
        : yield* previousToken(value.previousTokenId).pipe(Effect.catchTags(dieOnSchemaError));
    return {
      _tag: "pending",
      userCode: value.userCode,
      machineNameHint: value.machineName,
      previousToken: Option.getOrNull(previous),
      expiresAt: value.expiresAt
    } as const;
  });

  const confirm = Effect.fn("DeviceLogins.confirm")(
    (input: {
      readonly userCode: string;
      readonly accountId: string;
      readonly machineName: string;
      readonly confirmedBy: string;
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const row = yield* byUserCode(input.userCode).pipe(Effect.catchTags(dieOnSchemaError));
          if (
            Option.isNone(row) ||
            row.value.status !== "pending" ||
            row.value.expiresAt.getTime() <= now
          ) {
            return Option.none<{ id: string; name: string }>();
          }
          // The old token dies in the same act, unless it is someone else's:
          // then the login is treated as a first one, never an error.
          if (row.value.previousTokenId !== null) {
            const previous = yield* previousToken(row.value.previousTokenId).pipe(
              Effect.catchTags(dieOnSchemaError)
            );
            if (Option.isSome(previous) && previous.value.accountId === input.accountId) {
              yield* tokens.revoke(previous.value.id);
            }
          }
          const plaintext = `pp_${randomToken(32)}`;
          const machine = yield* tokens.create({
            accountId: input.accountId,
            name: input.machineName,
            scopes: ["upload"],
            token: plaintext
          });
          yield* sql`
          UPDATE prototype_device_logins
          SET status = 'confirmed', account_id = ${input.accountId}, api_token_id = ${machine.id},
              token_plaintext = ${plaintext}, confirmed_by = ${input.confirmedBy}
          WHERE id = ${row.value.id}`;
          return Option.some(machine);
        })
      )
  );

  const deny = Effect.fn("DeviceLogins.deny")(function* (code: string) {
    const now = yield* Clock.currentTimeMillis;
    const row = yield* byUserCode(code).pipe(Effect.catchTags(dieOnSchemaError));
    if (
      Option.isNone(row) ||
      row.value.status !== "pending" ||
      row.value.expiresAt.getTime() <= now
    ) {
      return false;
    }
    yield* sql`UPDATE prototype_device_logins SET status = 'denied' WHERE id = ${row.value.id}`;
    return true;
  });

  const poll = Effect.fn("DeviceLogins.poll")((deviceCode: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const row = yield* byDeviceCodeHash(sha256(deviceCode)).pipe(
          Effect.catchTags(dieOnSchemaError)
        );
        if (Option.isNone(row)) return { _tag: "gone", code: "unknown" } as const;
        const { value } = row;
        // Finished rows leave with the poll that reports them; a later poll
        // finds nothing and says so.
        if (value.status === "denied") {
          yield* remove(value.id);
          return { _tag: "gone", code: "denied" } as const;
        }
        if (value.status === "confirmed") {
          yield* remove(value.id);
          return {
            _tag: "complete",
            token: value.tokenPlaintext ?? "",
            machine: { id: value.apiTokenId ?? "", name: value.apiTokenName ?? "" },
            accountId: value.accountId ?? "",
            accountName: value.accountName ?? ""
          } as const;
        }
        if (value.expiresAt.getTime() <= now) {
          yield* remove(value.id);
          return { _tag: "gone", code: "expired" } as const;
        }
        const slowDown =
          value.lastPolledAt !== null &&
          now - value.lastPolledAt.getTime() < POLL_INTERVAL_SECONDS * 1_000;
        yield* sql`
          UPDATE prototype_device_logins SET last_polled_at = to_timestamp(${now / 1_000})
          WHERE id = ${value.id}`;
        return { _tag: "pending", slowDown, expiresAt: value.expiresAt } as const;
      })
    )
  );

  return DeviceLogins.of({ start, lookup, confirm, deny, poll });
});

export const layer = Layer.effect(DeviceLogins, make);
