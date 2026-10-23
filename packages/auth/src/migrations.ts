/**
 * Machine credentials and device-login state, id 2 in the global migration
 * sequence; Companies owns their user foreign keys. Squashed into one baseline
 * before launch; id 19 records when a person's credentials ended and when each
 * device login was confirmed, id 22 adds agent connections and their tokens, id 23 the
 * codes a consent's approval issues, id 26 the sign-ins Home has seen for the Final step
 * panel, and id 27 the setup links that tie an agent's setup to that panel.
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
  ),
  // An approved consent awaiting its code exchange: the code's hash and what it was approved
  // for, nothing else. `created_at` is the database's clock under the person's row lock, so a
  // code made at or before their credentials-ended stamp is dead. The exchange sets
  // `connection_id`, and the row then stays with that connection, so a replay at any time ends
  // it. Codes not yet exchanged are deleted once expired, and by agent access off.
  "0023_agent_consents": ddl(
    `CREATE TABLE agent_consents (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 64),
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    connection_id TEXT REFERENCES agent_connections(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX agent_consents_user_id_idx ON agent_consents(user_id)`,
    `CREATE INDEX agent_consents_unexchanged_idx
    ON agent_consents(expires_at) WHERE connection_id IS NULL`
  ),
  // The sign-ins (Clerk session ids) that reached Home, so the Final step panel knows a
  // person's first few and remembers Later for each. Kept for the first four and any in the
  // person's first week, connected or not; nothing reads them for anything else.
  "0026_setup_prompt_sign_ins": ddl(
    `CREATE TABLE setup_prompt_sign_ins (
    user_id TEXT NOT NULL REFERENCES users(id),
    sid TEXT NOT NULL CHECK (char_length(sid) BETWEEN 1 AND 128),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    later_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, sid)
    )`
  ),
  // A setup link is the `?s=` in the panel's setup line: random, one live per person for 30
  // minutes. It is no credential: it only lets the person's own panel follow the agent that
  // fetched it. The first device login started with it binds; its outcome is kept here, since
  // device logins are deleted when they complete, are denied or expire. `analytics_id` is a
  // separate random id for events, so the link's value never leaves Patchy.
  "0027_setup_links": ddl(
    `CREATE TABLE setup_links (
    id TEXT PRIMARY KEY CHECK (char_length(id) = 22),
    analytics_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    retired_at TIMESTAMPTZ,
    picked_up_at TIMESTAMPTZ,
    user_code TEXT,
    outcome TEXT CHECK (outcome IN ('pending', 'denied', 'contested', 'connected', 'other_account')),
    machine_token_id TEXT REFERENCES machine_tokens(id),
    confirmed_by TEXT REFERENCES users(id)
    )`,
    `CREATE INDEX setup_links_user_id_idx ON setup_links(user_id)`,
    `ALTER TABLE device_logins
    ADD COLUMN setup_link_id TEXT REFERENCES setup_links(id) ON DELETE SET NULL`
  )
};
