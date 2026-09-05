import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Identity } from "@patchy/api";
import { newInternalId, randomToken, sha256 } from "@patchy/core";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export class InvalidMachineName extends Schema.TaggedError<InvalidMachineName>()(
  "InvalidMachineName",
  { length: Schema.Int }
) {
  override get message() {
    return "A machine name must contain 1–64 characters.";
  }
}

export class UserUnavailable extends Schema.TaggedError<UserUnavailable>()("UserUnavailable", {
  userId: Schema.String
}) {
  override get message() {
    return `User ${this.userId} is missing or deactivated.`;
  }
}

export class MachineTokenNotFound extends Schema.TaggedError<MachineTokenNotFound>()(
  "MachineTokenNotFound",
  { id: Schema.String }
) {
  override get message() {
    return `Machine token ${this.id} was not found.`;
  }
}

const AuthenticationRow = Schema.Struct({
  identity: Identity,
  lastUsedAt: Schema.Date
});
const RevocationRow = Schema.Struct({ alreadyRevoked: Schema.Boolean });

export class MachineTokens extends Context.Service<
  MachineTokens,
  {
    readonly authenticate: (token: string) => Effect.Effect<Identity | null, SqlError>;
    readonly mint: (input: { readonly userId: string; readonly name: string }) => Effect.Effect<
      {
        readonly token: string;
        readonly id: string;
        readonly name: string;
        readonly expiresAt: string;
      },
      InvalidMachineName | UserUnavailable | SqlError
    >;
    readonly revoke: (
      id: string
    ) => Effect.Effect<{ readonly alreadyRevoked: boolean }, MachineTokenNotFound | SqlError>;
  }
>()("@patchy/auth/MachineTokens") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One join decides every bearer refusal; no credential state is cached.
  const findIdentity = SqlSchema.findOneOption({
    Request: Schema.Struct({ tokenHash: Schema.String, now: Schema.Number }),
    Result: AuthenticationRow,
    execute: ({ tokenHash, now }) => sql`
      SELECT json_build_object(
        'user', json_build_object('id', u.id, 'email', u.email, 'name', u.name),
        'company', json_build_object('id', c.id, 'handle', c.handle, 'name', c.name),
        'role', u.role,
        'machine', json_build_object('id', t.id, 'name', t.name)
      ) AS identity, t.last_used_at AS "lastUsedAt"
      FROM machine_tokens t
      JOIN users u ON u.id = t.user_id
      JOIN companies c ON c.id = u.company_id
      WHERE t.token_hash = ${tokenHash} AND t.revoked_at IS NULL
        AND t.expires_at >= to_timestamp(${now / 1_000})
        AND t.last_used_at >= to_timestamp(${(now - 30 * DAY_MS) / 1_000})
        AND u.deactivated_at IS NULL`
  });

  const revokeRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String, now: Schema.Number }),
    Result: RevocationRow,
    execute: ({ id, now }) => sql`
      WITH prior AS (
        SELECT id, revoked_at FROM machine_tokens WHERE id = ${id} FOR UPDATE
      ), revoked AS (
        UPDATE machine_tokens SET revoked_at = to_timestamp(${now / 1_000}) FROM prior
        WHERE machine_tokens.id = prior.id AND prior.revoked_at IS NULL
        RETURNING machine_tokens.id
      )
      SELECT prior.revoked_at IS NOT NULL AS "alreadyRevoked" FROM prior`
  });

  const authenticate = Effect.fn("MachineTokens.authenticate")(function* (token: string) {
    const now = yield* Clock.currentTimeMillis;
    const found = yield* findIdentity({ tokenHash: sha256(token), now }).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    if (Option.isNone(found)) return null;
    const { identity, lastUsedAt } = found.value;
    if (lastUsedAt.getTime() <= now - HOUR_MS) {
      // Recheck the stamp under the UPDATE lock: racing lookups cannot stamp
      // twice within an hour, or let an older request move the clock backwards.
      yield* sql`
        UPDATE machine_tokens SET last_used_at = to_timestamp(${now / 1_000})
        WHERE id = ${identity.machine.id} AND revoked_at IS NULL
          AND last_used_at <= to_timestamp(${(now - HOUR_MS) / 1_000})`;
    }
    return identity;
  });

  const mint = Effect.fn("MachineTokens.mint")(function* (input: {
    readonly userId: string;
    readonly name: string;
  }) {
    let length = 0;
    for (let index = 0; index < input.name.length; length++) {
      index += input.name.codePointAt(index)! > 0xffff ? 2 : 1;
    }
    if (length < 1 || length > 64 || input.name.trim().length === 0) {
      return yield* new InvalidMachineName({ length });
    }
    const now = yield* Clock.currentTimeMillis;
    const expires = now + 90 * DAY_MS;
    const id = newInternalId("tok");
    const token = `pp_${randomToken(32)}`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Serialize against deactivation so it cannot leave a newly minted live key.
        const users = yield* sql`
        SELECT id FROM users WHERE id = ${input.userId} AND deactivated_at IS NULL FOR UPDATE`;
        if (users.length === 0) return yield* new UserUnavailable({ userId: input.userId });
        yield* sql`
        INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
        VALUES (${id}, ${input.userId}, ${input.name}, ${sha256(token)},
          to_timestamp(${now / 1_000}), to_timestamp(${expires / 1_000}), to_timestamp(${now / 1_000}))`;
        return {
          token,
          id,
          name: input.name,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires))
        };
      })
    );
  });

  const revoke = Effect.fn("MachineTokens.revoke")(function* (id: string) {
    const result = yield* revokeRow({ id, now: yield* Clock.currentTimeMillis }).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    if (Option.isNone(result)) return yield* new MachineTokenNotFound({ id });
    return result.value;
  });

  return MachineTokens.of({ authenticate, mint, revoke });
});

export const layer = Layer.effect(MachineTokens, make);
