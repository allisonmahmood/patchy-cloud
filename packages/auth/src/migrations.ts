/**
 * Machine credentials and device-login state, id 2 in the global migration
 * sequence; Companies owns their user foreign keys. Squashed into one baseline
 * before launch; id 19 records when a person's credentials ended and when each
 * device login was confirmed.
 */
import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0002_auth": ddl(
    `CREATE TABLE machine_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
    )`,
    `CREATE INDEX machine_tokens_user_id_idx ON machine_tokens(user_id)`,
    `CREATE TABLE device_logins (
    user_code TEXT PRIMARY KEY,
    device_code_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'denied')),
    machine_name_hint TEXT NOT NULL,
    old_token_id TEXT REFERENCES machine_tokens(id),
    user_id TEXT REFERENCES users(id),
    machine_name TEXT CHECK (char_length(machine_name) BETWEEN 1 AND 64),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
  ),
  // When each person's credentials last all ended, by deactivation or by revoking every machine,
  // kept on Companies' user row and written in the ending's transaction. An approval at or before
  // it stays ended, whichever release ended it, so device logins now record when they were
  // confirmed. Nothing before this step recorded either, so both start empty.
  "0019_credentials_ended": ddl(
    `ALTER TABLE users ADD COLUMN credentials_ended_at TIMESTAMPTZ`,
    `ALTER TABLE device_logins ADD COLUMN confirmed_at TIMESTAMPTZ`
  )
};
