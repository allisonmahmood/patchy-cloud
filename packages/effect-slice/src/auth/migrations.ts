/** Migrations owned by the auth capability. Keyed `<id>_<name>`; ids are global across packages. */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const authMigrations = {
  "0001_accounts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
  }),
  "0002_api_tokens": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes JSONB NOT NULL DEFAULT '["upload"]'::jsonb,
        revoked_at TIMESTAMPTZ
      )`;
  })
};
