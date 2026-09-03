/**
 * The auth capability's schema: ids 1 and 2 of the global migration
 * sequence (`packages/sql/CONTEXT.md`), the baseline for `accounts`,
 * `api_tokens` and `token_mints`. `patches` takes 3 onward.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

const ddl = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement));

export const migrations: Migrations = {
  // A principal is an ownership row; a token is the credential that reaches
  // it. Only the token's hash is stored, so no row can produce a plaintext.
  // Revoked is a state (`revoked_at`), never a deletion: patch versions
  // reference the token that created them, and where a token came from
  // stays reviewable.
  "0001_accounts_and_api_tokens": ddl(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes JSONB NOT NULL DEFAULT '["upload"]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );
  `),
  // The mint record: which principal and token a self-service mint created,
  // from what source address, and when. It is what the mint quota counts,
  // which is why the index leads with the address — the quota's only query is
  // "how many rows for this address inside the window". Nullable because a
  // request need not have a usable address; those mints share one bucket
  // rather than escaping the count.
  "0002_token_mints": ddl(`
    CREATE TABLE token_mints (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      api_token_id TEXT NOT NULL REFERENCES api_tokens(id),
      source_ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX token_mints_source_ip_created_at_idx
      ON token_mints(source_ip, created_at);
  `),
  // PROTOTYPE for #119 (throwaway): the Clerk user -> Patchy account match the
  // login door reads on every page load. Id 90 leaves the real sequence alone.
  "0090_prototype_users": ddl(`
    CREATE TABLE prototype_users (
      clerk_user_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      email TEXT NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `),
  // PROTOTYPE for #131 (throwaway): one row per `patchy login` in flight.
  // The device code is stored hashed; the plaintext machine token sits here
  // between confirm and the poll that reports it, then the row is deleted.
  "0091_prototype_device_logins": ddl(`
    CREATE TABLE prototype_device_logins (
      id TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_code TEXT NOT NULL UNIQUE,
      machine_name TEXT,
      previous_token_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      account_id TEXT REFERENCES accounts(id),
      api_token_id TEXT REFERENCES api_tokens(id),
      token_plaintext TEXT,
      confirmed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_polled_at TIMESTAMPTZ
    );
  `)
};
