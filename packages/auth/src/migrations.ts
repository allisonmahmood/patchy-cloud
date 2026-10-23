/**
 * Machine credentials and device-login state, id 2 in the global migration
 * sequence; Companies owns their user foreign keys. Squashed into one baseline
 * before launch; id 19 records when a person's credentials ended and when each
 * device login was confirmed, and id 22 adds agent connections and their tokens.
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
  // confirmed. Both are the database's clock, read under the user's row lock, so servers whose
  // clocks disagree can't misorder them. Nothing before this step recorded either.
  "0019_credentials_ended": ddl(
    `ALTER TABLE users ADD COLUMN credentials_ended_at TIMESTAMPTZ`,
    `ALTER TABLE device_logins ADD COLUMN confirmed_at TIMESTAMPTZ`
  ),
  // Agent connections, the `work` credential, apart from machine tokens so neither door finds
  // the other's tokens. Every stamp is the database's clock. Each refresh token issued stays
  // until its connection goes, so any reuse is recognised; at most one is current, the chain.
  // `retry` holds the tokens a rotation returned, encrypted under the refresh token it rotated,
  // until the server's sweep drops it once its minute is up.
  "0022_agent_connections": ddl(
    `CREATE TABLE agent_connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 64),
    client_site TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
    )`,
    `CREATE INDEX agent_connections_user_id_idx ON agent_connections(user_id)`,
    `CREATE TABLE agent_connection_access_tokens (
    token_hash TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX agent_connection_access_tokens_connection_id_idx
    ON agent_connection_access_tokens(connection_id)`,
    `CREATE TABLE agent_connection_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
    rotated_at TIMESTAMPTZ,
    retry TEXT CHECK (retry IS NULL OR rotated_at IS NOT NULL)
    )`,
    `CREATE UNIQUE INDEX agent_connection_refresh_tokens_chain_idx
    ON agent_connection_refresh_tokens(connection_id) WHERE rotated_at IS NULL`,
    `CREATE INDEX agent_connection_refresh_tokens_retry_idx
    ON agent_connection_refresh_tokens(rotated_at) WHERE retry IS NOT NULL`
  )
};
