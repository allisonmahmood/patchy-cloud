import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export const Role = Schema.Literals(["member", "admin"]);
export type Role = typeof Role.Type;

export class User extends Schema.Class<User>("User")({
  id: Schema.String,
  clerkUserId: Schema.String,
  companyId: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Role,
  createdAt: Schema.Date,
  deactivatedAt: Schema.NullOr(Schema.Date)
}) {}

export class AlreadyInCompany extends Schema.TaggedError<AlreadyInCompany>()("AlreadyInCompany", {
  clerkUserId: Schema.String
}) {
  override get message() {
    return "Already in a company.";
  }
}

export class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  companyId: Schema.String,
  userId: Schema.String
}) {
  override get message() {
    return "User not found in this company.";
  }
}

export class LastAdmin extends Schema.TaggedError<LastAdmin>()("LastAdmin", {
  companyId: Schema.String,
  userId: Schema.String
}) {
  override get message() {
    return "The last active admin cannot be demoted or deactivated.";
  }
}

export interface UserRef {
  readonly companyId: string;
  readonly userId: string;
}

export interface Claims {
  readonly clerkUserId: string;
  readonly email: string;
  readonly name: string;
}

/** Admin actions are company-scoped; the caller authorizes the acting admin. */
export class Users extends Context.Service<
  Users,
  {
    readonly findByClerkId: (clerkUserId: string) => Effect.Effect<User | null, SqlError>;
    readonly findByEmail: (email: string) => Effect.Effect<User | null, SqlError>;
    readonly list: (companyId: string) => Effect.Effect<ReadonlyArray<User>, SqlError>;
    readonly refreshClaims: (claims: Claims) => Effect.Effect<User | null, SqlError>;
    readonly setRole: (
      input: UserRef & { readonly role: Role }
    ) => Effect.Effect<User, UserNotFound | LastAdmin | SqlError>;
    readonly deactivate: (
      input: UserRef
    ) => Effect.Effect<User, UserNotFound | LastAdmin | SqlError>;
    readonly reactivate: (input: UserRef) => Effect.Effect<User, UserNotFound | SqlError>;
  }
>()("@patchy/companies/Users") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`id, clerk_user_id AS "clerkUserId", company_id AS "companyId",
    email, name, role, created_at AS "createdAt", deactivated_at AS "deactivatedAt"`;
  const ref = Schema.Struct({ companyId: Schema.String, userId: Schema.String });
  const dieOnSchemaError = { SchemaError: Effect.die } as const;

  const byClerkId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: User,
    execute: (clerkUserId) => sql`SELECT ${columns} FROM users WHERE clerk_user_id = ${clerkUserId}`
  });
  const byEmail = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: User,
    execute: (email) => sql`SELECT ${columns} FROM users WHERE email = ${email}`
  });
  const companyUsers = SqlSchema.findAll({
    Request: Schema.String,
    Result: User,
    execute: (companyId) =>
      sql`SELECT ${columns} FROM users WHERE company_id = ${companyId} ORDER BY created_at, id`
  });
  const lockedUser = SqlSchema.findOneOption({
    Request: ref,
    Result: User,
    execute: ({ companyId, userId }) => sql`
      SELECT ${columns} FROM users WHERE company_id = ${companyId} AND id = ${userId} FOR UPDATE`
  });
  const activeAdmins = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: (companyId) => sql`
      SELECT count(*)::int AS count FROM users
      WHERE company_id = ${companyId} AND role = 'admin' AND deactivated_at IS NULL`
  });
  const refresh = SqlSchema.findOneOption({
    Request: Schema.Struct({
      clerkUserId: Schema.String,
      email: Schema.String,
      name: Schema.String
    }),
    Result: User,
    execute: ({ clerkUserId, email, name }) => sql`
      UPDATE users SET email = ${email}, name = ${name}
      WHERE clerk_user_id = ${clerkUserId}
        AND (email IS DISTINCT FROM ${email} OR name IS DISTINCT FROM ${name})
      RETURNING ${columns}`
  });

  const findByClerkId = Effect.fn("Users.findByClerkId")((clerkUserId: string) =>
    byClerkId(clerkUserId).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull))
  );
  const findByEmail = Effect.fn("Users.findByEmail")((email: string) =>
    byEmail(email.toLowerCase()).pipe(
      Effect.catchTags(dieOnSchemaError),
      Effect.map(Option.getOrNull)
    )
  );
  const list = Effect.fn("Users.list")((companyId: string) =>
    companyUsers(companyId).pipe(Effect.catchTags(dieOnSchemaError))
  );
  const refreshClaims = Effect.fn("Users.refreshClaims")(function* (claims: Claims) {
    const updated = yield* refresh({ ...claims, email: claims.email.toLowerCase() }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    return Option.isSome(updated) ? updated.value : yield* findByClerkId(claims.clerkUserId);
  });

  // Lock the company before reading any user's role. Locking only the target
  // users lets two admins each see the other and both remove the final admin.
  const lockUser = Effect.fn("Users.lockUser")(function* (input: UserRef) {
    yield* sql`SELECT id FROM companies WHERE id = ${input.companyId} FOR UPDATE`;
    const found = yield* lockedUser(input).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(found)) return yield* new UserNotFound(input);
    return found.value;
  });
  const preserveAdmin = Effect.fn("Users.preserveAdmin")(function* (user: User) {
    if (user.role !== "admin" || user.deactivatedAt !== null) return;
    const { count } = yield* activeAdmins(user.companyId).pipe(
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    );
    if (count <= 1) return yield* new LastAdmin({ companyId: user.companyId, userId: user.id });
  });

  const setRole = Effect.fn("Users.setRole")((input: UserRef & { readonly role: Role }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const user = yield* lockUser(input);
        if (user.role === input.role) return user;
        if (input.role === "member") yield* preserveAdmin(user);
        yield* sql`UPDATE users SET role = ${input.role} WHERE id = ${input.userId}`;
        return new User({ ...user, role: input.role });
      })
    )
  );
  const deactivate = Effect.fn("Users.deactivate")((input: UserRef) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const user = yield* lockUser(input);
        yield* preserveAdmin(user);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
        UPDATE users SET deactivated_at = to_timestamp(${now / 1_000})
        WHERE id = ${input.userId} AND deactivated_at IS NULL`;
        // Auth owns the rows. Keep this revocation in the user transaction, and
        // preserve earlier revocation stamps; reactivation never revives keys.
        yield* sql`
        UPDATE machine_tokens SET revoked_at = to_timestamp(${now / 1_000})
        WHERE user_id = ${input.userId} AND revoked_at IS NULL`;
        const updated = yield* lockedUser(input).pipe(Effect.catchTags(dieOnSchemaError));
        return Option.getOrThrow(updated);
      })
    )
  );
  const reactivate = Effect.fn("Users.reactivate")((input: UserRef) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const user = yield* lockUser(input);
        if (user.deactivatedAt === null) return user;
        yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = ${input.userId}`;
        return new User({ ...user, deactivatedAt: null });
      })
    )
  );

  return Users.of({
    findByClerkId,
    findByEmail,
    list,
    refreshClaims,
    setRole,
    deactivate,
    reactivate
  });
});

export const layer = Layer.effect(Users, make);
