import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { newInternalId } from "@patchy/core";
import { AlreadyInCompany, Role, User, type Claims } from "./Users.js";

/** Fixed once created: handles are not normalized into a different address. */
export const Handle = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/));
export const isHandle = Schema.is(Handle);
export const RESERVED_HANDLES: ReadonlyArray<string> = [
  "api",
  "d",
  "admin",
  "patchy",
  "login",
  "logout",
  "machines",
  "company",
  "join",
  "healthz",
  "www",
  "app",
  "auth",
  "support",
  "help",
  "settings",
  "billing",
  "status",
  "assets",
  "static",
  "invite",
  "signup",
  "signin"
];

export class Company extends Schema.Class<Company>("Company")({
  id: Schema.String,
  handle: Schema.String,
  name: Schema.String,
  createdAt: Schema.Date
}) {}

export class Invite extends Schema.Class<Invite>("Invite")({
  id: Schema.String,
  companyId: Schema.String,
  email: Schema.String,
  role: Role,
  invitedBy: Schema.String,
  clerkInvitationId: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date),
  consumedAt: Schema.NullOr(Schema.Date)
}) {}

export class InvalidHandle extends Schema.TaggedError<InvalidHandle>()("InvalidHandle", {
  length: Schema.Int
}) {
  override get message() {
    return "Use 3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen.";
  }
}
export class ReservedHandle extends Schema.TaggedError<ReservedHandle>()("ReservedHandle", {
  handle: Schema.String
}) {
  override get message() {
    return `The handle ${this.handle} is reserved.`;
  }
}
export class HandleTaken extends Schema.TaggedError<HandleTaken>()("HandleTaken", {
  handle: Schema.String
}) {
  override get message() {
    return `The handle ${this.handle} is already taken.`;
  }
}
export class CompanyNotFound extends Schema.TaggedError<CompanyNotFound>()("CompanyNotFound", {
  companyId: Schema.String
}) {
  override get message() {
    return "Company not found.";
  }
}
export class AlreadyInvited extends Schema.TaggedError<AlreadyInvited>()("AlreadyInvited", {
  companyId: Schema.String
}) {
  override get message() {
    return "This email already has a pending invitation to this company.";
  }
}
export class InviteUnavailable extends Schema.TaggedError<InviteUnavailable>()(
  "InviteUnavailable",
  {
    inviteId: Schema.String
  }
) {
  override get message() {
    return "Invitation not found, revoked or already consumed.";
  }
}

export interface CreateInput {
  readonly handle: string;
  readonly name: string;
  readonly clerkUserId: string;
  readonly email: string;
  readonly userName: string;
}
export interface InviteInput {
  readonly companyId: string;
  readonly email: string;
  readonly role?: Role;
  readonly invitedBy: string;
}

/** Admin actions are authorized by the caller; this service never sends mail. */
export class Companies extends Context.Service<
  Companies,
  {
    readonly create: (
      input: CreateInput
    ) => Effect.Effect<
      { readonly company: Company; readonly user: User },
      InvalidHandle | ReservedHandle | HandleTaken | AlreadyInCompany | SqlError
    >;
    readonly findById: (companyId: string) => Effect.Effect<Company | null, SqlError>;
    readonly createInvite: (
      input: InviteInput
    ) => Effect.Effect<Invite, CompanyNotFound | AlreadyInCompany | AlreadyInvited | SqlError>;
    readonly listInvites: (companyId: string) => Effect.Effect<ReadonlyArray<Invite>, SqlError>;
    readonly findInvitesByEmail: (email: string) => Effect.Effect<ReadonlyArray<Invite>, SqlError>;
    readonly revokeInvite: (input: {
      readonly companyId: string;
      readonly inviteId: string;
    }) => Effect.Effect<Invite, InviteUnavailable | SqlError>;
    readonly consumeInvite: (
      input: Claims & { readonly inviteId: string }
    ) => Effect.Effect<User, AlreadyInCompany | InviteUnavailable | SqlError>;
  }
>()("@patchy/companies/Companies") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  const companyColumns = sql`id, handle, name, created_at AS "createdAt"`;
  const userColumns = sql`id, clerk_user_id AS "clerkUserId", company_id AS "companyId",
    email, name, role, created_at AS "createdAt", deactivated_at AS "deactivatedAt"`;
  const inviteColumns = sql`id, company_id AS "companyId", email, role, invited_by AS "invitedBy",
    clerk_invitation_id AS "clerkInvitationId", created_at AS "createdAt",
    revoked_at AS "revokedAt", consumed_at AS "consumedAt"`;
  const companyById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Company,
    execute: (id) => sql`SELECT ${companyColumns} FROM companies WHERE id = ${id}`
  });
  const insertCompany = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Schema.String,
      handle: Schema.String,
      name: Schema.String,
      now: Schema.Number
    }),
    Result: Company,
    execute: ({ id, handle, name, now }) => sql`
      INSERT INTO companies (id, handle, name, created_at)
      VALUES (${id}, ${handle}, ${name}, to_timestamp(${now / 1_000}))
      ON CONFLICT (handle) DO NOTHING RETURNING ${companyColumns}`
  });
  const insertUser = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Schema.String,
      companyId: Schema.String,
      clerkUserId: Schema.String,
      email: Schema.String,
      name: Schema.String,
      role: Role,
      now: Schema.Number
    }),
    Result: User,
    execute: ({ id, companyId, clerkUserId, email, name, role, now }) => sql`
      INSERT INTO users (id, company_id, clerk_user_id, email, name, role, created_at)
      VALUES (${id}, ${companyId}, ${clerkUserId}, ${email}, ${name}, ${role}, to_timestamp(${now / 1_000}))
      ON CONFLICT DO NOTHING RETURNING ${userColumns}`
  });
  const existingUser = SqlSchema.findOneOption({
    Request: Schema.Struct({ email: Schema.String, clerkUserId: Schema.NullOr(Schema.String) }),
    Result: Schema.Struct({ clerkUserId: Schema.String }),
    execute: ({ email, clerkUserId }) => sql`
      SELECT clerk_user_id AS "clerkUserId" FROM users
      WHERE email = ${email} OR clerk_user_id = ${clerkUserId} LIMIT 1`
  });
  const insertInvite = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Schema.String,
      companyId: Schema.String,
      email: Schema.String,
      role: Role,
      invitedBy: Schema.String,
      now: Schema.Number
    }),
    Result: Invite,
    execute: ({ id, companyId, email, role, invitedBy, now }) => sql`
      INSERT INTO invites (id, company_id, email, role, invited_by, created_at)
      VALUES (${id}, ${companyId}, ${email}, ${role}, ${invitedBy}, to_timestamp(${now / 1_000}))
      ON CONFLICT (company_id, email) WHERE revoked_at IS NULL AND consumed_at IS NULL
      DO NOTHING RETURNING ${inviteColumns}`
  });
  const companyInvites = SqlSchema.findAll({
    Request: Schema.String,
    Result: Invite,
    execute: (companyId) => sql`
      SELECT ${inviteColumns} FROM invites WHERE company_id = ${companyId}
        AND revoked_at IS NULL AND consumed_at IS NULL ORDER BY created_at, id`
  });
  const emailInvites = SqlSchema.findAll({
    Request: Schema.String,
    Result: Invite,
    execute: (email) => sql`
      SELECT ${inviteColumns} FROM invites WHERE email = ${email}
        AND revoked_at IS NULL AND consumed_at IS NULL ORDER BY created_at, id`
  });
  const revokeRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      inviteId: Schema.String,
      now: Schema.Number
    }),
    Result: Invite,
    execute: ({ companyId, inviteId, now }) => sql`
      UPDATE invites SET revoked_at = COALESCE(revoked_at, to_timestamp(${now / 1_000}))
      WHERE id = ${inviteId} AND company_id = ${companyId} AND consumed_at IS NULL
      RETURNING ${inviteColumns}`
  });
  const lockInvite = SqlSchema.findOneOption({
    Request: Schema.Struct({ inviteId: Schema.String, email: Schema.String }),
    Result: Invite,
    execute: ({ inviteId, email }) => sql`
      SELECT ${inviteColumns} FROM invites WHERE id = ${inviteId} AND email = ${email}
        AND revoked_at IS NULL AND consumed_at IS NULL FOR UPDATE`
  });

  const findById = Effect.fn("Companies.findById")((companyId: string) =>
    companyById(companyId).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull))
  );
  const create = Effect.fn("Companies.create")((input: CreateInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (RESERVED_HANDLES.includes(input.handle))
          return yield* new ReservedHandle({ handle: input.handle });
        const handleLength = input.handle.length;
        if (!isHandle(input.handle)) return yield* new InvalidHandle({ length: handleLength });
        const now = yield* Clock.currentTimeMillis;
        const company = yield* insertCompany({
          id: newInternalId("cmp"),
          handle: input.handle,
          name: input.name,
          now
        });
        if (Option.isNone(company)) return yield* new HandleTaken({ handle: input.handle });
        const user = yield* insertUser({
          id: newInternalId("usr"),
          companyId: company.value.id,
          clerkUserId: input.clerkUserId,
          email: input.email.toLowerCase(),
          name: input.userName,
          role: "admin",
          now
        });
        if (Option.isNone(user))
          return yield* new AlreadyInCompany({ clerkUserId: input.clerkUserId });
        return { company: company.value, user: user.value };
      }).pipe(Effect.catchTags(dieOnSchemaError))
    )
  );
  const createInvite = Effect.fn("Companies.createInvite")((input: InviteInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const company = yield* findById(input.companyId);
        if (company === null) return yield* new CompanyNotFound({ companyId: input.companyId });
        const email = input.email.toLowerCase();
        const user = yield* existingUser({ email, clerkUserId: null });
        if (Option.isSome(user))
          return yield* new AlreadyInCompany({ clerkUserId: user.value.clerkUserId });
        const now = yield* Clock.currentTimeMillis;
        const invite = yield* insertInvite({
          id: newInternalId("inv"),
          companyId: input.companyId,
          email,
          role: input.role ?? "member",
          invitedBy: input.invitedBy,
          now
        });
        if (Option.isNone(invite)) return yield* new AlreadyInvited({ companyId: input.companyId });
        return invite.value;
      }).pipe(Effect.catchTags(dieOnSchemaError))
    )
  );
  const listInvites = Effect.fn("Companies.listInvites")((companyId: string) =>
    companyInvites(companyId).pipe(Effect.catchTags(dieOnSchemaError))
  );
  const findInvitesByEmail = Effect.fn("Companies.findInvitesByEmail")((email: string) =>
    emailInvites(email.toLowerCase()).pipe(Effect.catchTags(dieOnSchemaError))
  );
  const revokeInvite = Effect.fn("Companies.revokeInvite")(function* (input: {
    readonly companyId: string;
    readonly inviteId: string;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const invite = yield* revokeRow({ ...input, now }).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(invite)) return yield* new InviteUnavailable({ inviteId: input.inviteId });
    return invite.value;
  });
  const consumeInvite = Effect.fn("Companies.consumeInvite")(
    (input: Claims & { readonly inviteId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const email = input.email.toLowerCase();
          const existing = yield* existingUser({ email, clerkUserId: input.clerkUserId });
          if (Option.isSome(existing))
            return yield* new AlreadyInCompany({ clerkUserId: input.clerkUserId });
          const invite = yield* lockInvite({ inviteId: input.inviteId, email });
          if (Option.isNone(invite))
            return yield* new InviteUnavailable({ inviteId: input.inviteId });
          const now = yield* Clock.currentTimeMillis;
          const user = yield* insertUser({
            id: newInternalId("usr"),
            companyId: invite.value.companyId,
            clerkUserId: input.clerkUserId,
            email,
            name: input.name,
            role: invite.value.role,
            now
          });
          // The unique Clerk id/email constraints arbitrate concurrent joins to
          // different companies. A losing transaction never consumes its invite.
          if (Option.isNone(user))
            return yield* new AlreadyInCompany({ clerkUserId: input.clerkUserId });
          yield* sql`UPDATE invites SET consumed_at = to_timestamp(${now / 1_000}) WHERE id = ${input.inviteId}`;
          return user.value;
        }).pipe(Effect.catchTags(dieOnSchemaError))
      )
  );

  return Companies.of({
    create,
    findById,
    createInvite,
    listInvites,
    findInvitesByEmail,
    revokeInvite,
    consumeInvite
  });
});

export const layer = Layer.effect(Companies, make);
