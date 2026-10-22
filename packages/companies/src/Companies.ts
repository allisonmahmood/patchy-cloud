import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { newInternalId, WhatsNew } from "@patchy/core";
import { AlreadyInCompany, displayName, Role, User, type Claims } from "./Users.js";

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
  "patches",
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
  "signin",
  "whats-new",
  // The Patchy MCP door and its authorization server (docs/product.md › The door)
  "mcp",
  "oauth"
];

export class Company extends Schema.Class<Company>("Company")({
  id: Schema.String,
  handle: Schema.String,
  name: Schema.String,
  createdAt: Schema.Date
}) {}

/**
 * A company's agent access switch (docs/product.md › Patchy MCP) and its latest change, which
 * is null for the starting Off. Only the latest change is kept.
 */
export interface AgentAccess {
  readonly on: boolean;
  readonly latest: {
    readonly by: { readonly id: string; readonly name: string };
    readonly at: Date;
  } | null;
}

// Clerk's application invitation default: https://clerk.com/docs/reference/backend/invitations/create-invitation
export const INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

export class Invite extends Schema.Class<Invite>("Invite")({
  id: Schema.String,
  companyId: Schema.String,
  email: Schema.String,
  role: Role,
  invitedBy: Schema.String,
  clerkInvitationId: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
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
    return "Invitation not found, expired, revoked or already consumed.";
  }
}

export interface CreateInput {
  readonly handle: string;
  readonly name: string;
  readonly clerkUserId: string;
  readonly email: string;
  readonly userName: string;
}
export interface AgentAccessInput {
  readonly companyId: string;
  readonly on: boolean;
  /** The admin making the change. */
  readonly by: string;
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
    /** Whether a company already holds this handle; create still settles a race by its unique insert. */
    readonly isHandleTaken: (handle: string) => Effect.Effect<boolean, SqlError>;
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
    readonly agentAccess: (
      companyId: string
    ) => Effect.Effect<AgentAccess, CompanyNotFound | SqlError>;
    /**
     * Whether agent access is on, held until the caller's transaction ends: a change waits for
     * the holder, and the read waits for a change in flight. Code issuance and the code exchange
     * hold it, so neither acts on an on that an off has already replaced.
     */
    readonly holdAgentAccess: (
      companyId: string
    ) => Effect.Effect<boolean, CompanyNotFound | SqlError>;
    /** Turns agent access on or off; asking for the state it already has changes nothing. */
    readonly setAgentAccess: (
      input: AgentAccessInput
    ) => Effect.Effect<
      { readonly access: AgentAccess; readonly changed: boolean },
      CompanyNotFound | SqlError
    >;
  }
>()("@patchy/companies/Companies") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  const companyColumns = sql`id, handle, name, created_at AS "createdAt"`;
  const userColumns = sql`id, clerk_user_id AS "clerkUserId", company_id AS "companyId",
    email, name, role, created_at AS "createdAt", deactivated_at AS "deactivatedAt",
    whats_new_seen AS "whatsNewSeen"`;
  const inviteColumns = sql`id, company_id AS "companyId", email, role, invited_by AS "invitedBy",
    clerk_invitation_id AS "clerkInvitationId", created_at AS "createdAt", expires_at AS "expiresAt",
    revoked_at AS "revokedAt", consumed_at AS "consumedAt"`;
  const companyById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Company,
    execute: (id) => sql`SELECT ${companyColumns} FROM companies WHERE id = ${id}`
  });
  const companyByHandle = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Company,
    execute: (handle) => sql`SELECT ${companyColumns} FROM companies WHERE handle = ${handle}`
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
    // Creation and invitation acceptance both land here, so the name rule applies once.
    // A new member starts caught up on What's new; the history is still one click away.
    execute: ({ id, companyId, clerkUserId, email, name, role, now }) => sql`
      INSERT INTO users (id, company_id, clerk_user_id, email, name, role, created_at, whats_new_seen)
      VALUES (${id}, ${companyId}, ${clerkUserId}, ${email}, ${displayName({ name, email })}, ${role},
        to_timestamp(${now / 1_000}), ${WhatsNew.latestRelease})
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
      INSERT INTO invites (id, company_id, email, role, invited_by, created_at, expires_at)
      VALUES (${id}, ${companyId}, ${email}, ${role}, ${invitedBy}, to_timestamp(${now / 1_000}),
        to_timestamp(${(now + INVITATION_LIFETIME_MS) / 1_000}))
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
    Request: Schema.Struct({ email: Schema.String, now: Schema.Number }),
    Result: Invite,
    execute: ({ email, now }) => sql`
      SELECT ${inviteColumns} FROM invites WHERE email = ${email}
        AND revoked_at IS NULL AND consumed_at IS NULL
        AND expires_at > to_timestamp(${now / 1_000}) ORDER BY created_at, id`
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

  const agentAccessRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      on: Schema.Boolean,
      byId: Schema.NullOr(Schema.String),
      byName: Schema.NullOr(Schema.String),
      at: Schema.NullOr(Schema.Date)
    }),
    execute: (companyId) => sql`
      SELECT c.agent_access_on AS "on", u.id AS "byId", u.name AS "byName",
        c.agent_access_changed_at AS "at"
      FROM companies c LEFT JOIN users u ON u.id = c.agent_access_changed_by
      WHERE c.id = ${companyId}`
  });
  // A share lock on the company row: changes update that row, so they wait for its holders. It
  // reads the switch alone, because a read that waited re-reads only the locked row, not a join.
  const heldAgentAccess = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ on: Schema.Boolean }),
    execute: (companyId) => sql`
      SELECT agent_access_on AS "on" FROM companies WHERE id = ${companyId} FOR SHARE`
  });
  const changeAgentAccess = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      on: Schema.Boolean,
      by: Schema.String,
      now: Schema.Number
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ companyId, on, by, now }) => sql`
      UPDATE companies SET agent_access_on = ${on}, agent_access_changed_by = ${by},
        agent_access_changed_at = to_timestamp(${now / 1_000})
      WHERE id = ${companyId} AND agent_access_on <> ${on} RETURNING id`
  });

  const findById = Effect.fn("Companies.findById")((companyId: string) =>
    companyById(companyId).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull))
  );
  const isHandleTaken = Effect.fn("Companies.isHandleTaken")((handle: string) =>
    companyByHandle(handle).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.isSome))
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
  const findInvitesByEmail = Effect.fn("Companies.findInvitesByEmail")(function* (email: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* emailInvites({ email: email.toLowerCase(), now }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
  });
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
          const now = yield* Clock.currentTimeMillis;
          if (Option.isNone(invite) || invite.value.expiresAt.getTime() <= now)
            return yield* new InviteUnavailable({ inviteId: input.inviteId });
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

  const agentAccess = Effect.fn("Companies.agentAccess")(function* (companyId: string) {
    const row = yield* agentAccessRow(companyId).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(row)) return yield* new CompanyNotFound({ companyId });
    const { on, byId, byName, at } = row.value;
    return {
      on,
      latest:
        byId === null || byName === null || at === null
          ? null
          : { by: { id: byId, name: byName }, at }
    } satisfies AgentAccess;
  });
  const holdAgentAccess = Effect.fn("Companies.holdAgentAccess")(function* (companyId: string) {
    const row = yield* heldAgentAccess(companyId).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(row)) return yield* new CompanyNotFound({ companyId });
    return row.value.on;
  });
  const setAgentAccess = Effect.fn("Companies.setAgentAccess")((input: AgentAccessInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const changed = yield* changeAgentAccess({ ...input, now }).pipe(
          Effect.catchTags(dieOnSchemaError)
        );
        return { access: yield* agentAccess(input.companyId), changed: changed.length > 0 };
      })
    )
  );

  return Companies.of({
    create,
    findById,
    isHandleTaken,
    createInvite,
    listInvites,
    findInvitesByEmail,
    revokeInvite,
    consumeInvite,
    agentAccess,
    holdAgentAccess,
    setAgentAccess
  });
});

export const layer = Layer.effect(Companies, make);
