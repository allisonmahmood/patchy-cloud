/** Machine credentials and device-login state; Companies owns their user foreign keys. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0002_auth_baseline": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe(`
    CREATE TABLE machine_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX machine_tokens_user_id_idx ON machine_tokens(user_id);

    CREATE TABLE device_logins (
      user_code TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'denied')),
      machine_name_hint TEXT NOT NULL,
      old_token_id TEXT REFERENCES machine_tokens(id),
      user_id TEXT REFERENCES users(id),
      machine_name TEXT CHECK (char_length(machine_name) BETWEEN 1 AND 64),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  )
};
