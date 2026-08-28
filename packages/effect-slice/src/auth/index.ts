/** The auth capability: bearer tokens resolve to an Identity. */
import { sha256 } from "@patchy/core";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Authorization, CurrentIdentity, Identity } from "../api.js";

export { authMigrations } from "./migrations.js";

const findIdentityByTokenHash = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Identity,
    execute: (tokenHash) => sql`
      SELECT t.account_id AS "accountId", a.name AS "accountName",
             t.id AS "apiTokenId", t.name AS "apiTokenName", t.scopes
      FROM api_tokens t JOIN accounts a ON a.id = t.account_id
      WHERE t.token_hash = ${tokenHash} AND t.revoked_at IS NULL`
  });
});

/** Server side of the Authorization middleware: one query per request, fails closed. */
export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const findIdentity = yield* findIdentityByTokenHash;
    return Authorization.of({
      bearer: Effect.fn("Authorization.bearer")(function* (httpEffect, { credential }) {
        // A decode failure is a bug, not a bad token; a database failure is a 500, not a 401.
        const identity = yield* findIdentity(sha256(Redacted.value(credential))).pipe(
          Effect.catchTags({ SchemaError: Effect.die, SqlError: Effect.die })
        );
        if (identity._tag === "None") {
          return yield* Effect.fail({ ok: false as const, error: "Missing or invalid API token." });
        }
        return yield* Effect.provideService(httpEffect, CurrentIdentity, identity.value);
      })
    });
  })
);
