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
  `)
};
