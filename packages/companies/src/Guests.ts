import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { newInternalId } from "@patchy/core";
import { displayName, type Claims } from "./Users.js";

/** A company's guest identity, distinct from any member user with the same Clerk account. */
export class Guest extends Schema.Class<Guest>("CompanyGuest")({
  id: Schema.String,
  companyId: Schema.String,
  clerkUserId: Schema.String,
  email: Schema.String,
  name: Schema.String,
  createdAt: Schema.Date,
  deactivatedAt: Schema.NullOr(Schema.Date),
  endedAt: Schema.NullOr(Schema.Date)
}) {}

export class AlreadyMember extends Schema.TaggedError<AlreadyMember>()("GuestAlreadyMember", {
  companyId: Schema.String,
  clerkUserId: Schema.String
}) {
  override get message() {
    return "This account is already a member of the company.";
  }
}

export class GuestAlreadyExists extends Schema.TaggedError<GuestAlreadyExists>()(
  "GuestAlreadyExists",
  { companyId: Schema.String, clerkUserId: Schema.String }
) {
  override get message() {
    return "This account already has a guest relationship in the company.";
  }
}

export interface GuestRef {
  readonly companyId: string;
  readonly clerkUserId: string;
}

export interface CreateInput extends GuestRef, Pick<Claims, "email" | "name"> {}

const columns = `id, company_id AS "companyId", clerk_user_id AS "clerkUserId",
  email, name, created_at AS "createdAt", deactivated_at AS "deactivatedAt",
  ended_at AS "endedAt"`;
const dieOnSchemaError = { SchemaError: Effect.die } as const;

/** Caller resolves an existing Clerk account before creation and authorizes all changes. */
export const create = Effect.fn("Guests.create")(function* (input: CreateInput) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // This is the same lock used by the insert triggers, so a concurrent member join
      // either wins and refuses creation or ends this new guest before it commits.
      yield* sql`SELECT companies_guest_member_lock(${input.companyId}, ${input.clerkUserId})`;
      const members = yield* sql`SELECT id FROM users
        WHERE company_id = ${input.companyId} AND clerk_user_id = ${input.clerkUserId}
          AND deactivated_at IS NULL`;
      if (members.length > 0) return yield* new AlreadyMember(input);
      const email = input.email.toLowerCase();
      const inserted = SqlSchema.findOneOption({
        Request: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
        Result: Guest,
        execute: ({ id, email, name }) =>
          sql.unsafe(
            `INSERT INTO company_guests (id, company_id, clerk_user_id, email, name)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (company_id, clerk_user_id) DO NOTHING RETURNING ${columns}`,
            [id, input.companyId, input.clerkUserId, email, name]
          )
      });
      const guest = yield* inserted({
        id: newInternalId("gst"),
        email,
        name: displayName({ email, name: input.name })
      }).pipe(Effect.catchTags(dieOnSchemaError));
      if (Option.isNone(guest)) return yield* new GuestAlreadyExists(input);
      return guest.value;
    })
  );
});

export const find = Effect.fn("Guests.find")(function* (input: GuestRef) {
  const sql = yield* SqlClient.SqlClient;
  const row = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, clerkUserId: Schema.String }),
    Result: Guest,
    execute: ({ companyId, clerkUserId }) =>
      sql.unsafe(
        `SELECT ${columns} FROM company_guests WHERE company_id = $1 AND clerk_user_id = $2`,
        [companyId, clerkUserId]
      )
  });
  return yield* row(input).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull));
});

/** Explicit sharing may reopen an ended identity, never an admin-deactivated relationship.
 * Ended patch grants stay terminal; the caller creates only the selected patch's new grant.
 * Caller holds the identity lock and wraps this and grant creation in one transaction.
 */
export const reopenForShare = Effect.fn("Guests.reopenForShare")(function* (input: GuestRef) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE company_guests SET ended_at = NULL
    WHERE company_id = ${input.companyId} AND clerk_user_id = ${input.clerkUserId}
      AND ended_at IS NOT NULL AND deactivated_at IS NULL`;
});

/** Refresh only this company's relationship; ended identities retain their historical claims. */
export const refreshClaims = Effect.fn("Guests.refreshClaims")(function* (input: CreateInput) {
  const found = yield* find(input);
  if (!found || found.endedAt !== null || found.deactivatedAt !== null) return found;
  const email = input.email.toLowerCase();
  const name = displayName({ email, name: input.name });
  if (found.email === email && found.name === name) return found;
  const sql = yield* SqlClient.SqlClient;
  const refresh = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, clerkUserId: Schema.String }),
    Result: Guest,
    execute: ({ companyId, clerkUserId }) =>
      sql.unsafe(
        `UPDATE company_guests SET email = $3, name = $4
         WHERE company_id = $1 AND clerk_user_id = $2 AND ended_at IS NULL
         RETURNING ${columns}`,
        [companyId, clerkUserId, email, name]
      )
  });
  // The returned row includes any deactivation that committed while the write waited.
  const updated = yield* refresh(input).pipe(Effect.catchTags(dieOnSchemaError));
  return Option.isSome(updated) ? updated.value : yield* find(input);
});

/** Historical callers resolve by the stable guest row ID, including after access ends. */
export const findById = Effect.fn("Guests.findById")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const row = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Guest,
    execute: (guestId) =>
      sql.unsafe(`SELECT ${columns} FROM company_guests WHERE id = $1`, [guestId])
  });
  return yield* row(id).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull));
});

export const listByClerkId = Effect.fn("Guests.listByClerkId")(function* (clerkUserId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Guest,
    execute: (id) =>
      sql.unsafe(
        `SELECT ${columns} FROM company_guests WHERE clerk_user_id = $1 ORDER BY company_id`,
        [id]
      )
  });
  return yield* rows(clerkUserId).pipe(Effect.catchTags(dieOnSchemaError));
});

/** Internal roster, including ended/deactivated identities. Caller authorizes company access. */
export const listByCompany = Effect.fn("Guests.listByCompany")(function* (companyId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Guest,
    execute: (id) =>
      sql.unsafe(`SELECT ${columns} FROM company_guests WHERE company_id = $1 ORDER BY name, id`, [
        id
      ])
  });
  return yield* rows(companyId).pipe(Effect.catchTags(dieOnSchemaError));
});

/** Deactivation is reversible. Ending closes grants and keeps the identity for later explicit sharing. */
export const setDeactivated = Effect.fn("Guests.setDeactivated")(function* (
  input: GuestRef & { readonly deactivated: boolean }
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      clerkUserId: Schema.String,
      deactivated: Schema.Boolean
    }),
    Result: Guest,
    execute: ({ companyId, clerkUserId, deactivated }) =>
      sql.unsafe(
        `UPDATE company_guests SET deactivated_at = CASE WHEN $3 THEN COALESCE(deactivated_at, now()) ELSE NULL END
       WHERE company_id = $1 AND clerk_user_id = $2 RETURNING ${columns}`,
        [companyId, clerkUserId, deactivated]
      )
  });
  return yield* rows(input).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull));
});

export const end = Effect.fn("Guests.end")(function* (input: GuestRef) {
  const sql = yield* SqlClient.SqlClient;
  const rows = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, clerkUserId: Schema.String }),
    Result: Guest,
    execute: ({ companyId, clerkUserId }) =>
      sql.unsafe(
        `UPDATE company_guests SET ended_at = COALESCE(ended_at, now())
       WHERE company_id = $1 AND clerk_user_id = $2 RETURNING ${columns}`,
        [companyId, clerkUserId]
      )
  });
  return yield* rows(input).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull));
});
