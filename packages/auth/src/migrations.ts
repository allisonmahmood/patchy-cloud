/**
 * Machine credentials and device-login state, id 2 in the global migration
 * sequence; Companies owns their user foreign keys. Squashed into one baseline
 * before launch; id 19 adds agent connections: each token's purpose and the
 * OAuth clients and codes that mint `use` tokens.
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
  // A machine token builds (the CLI's, every token so far) or uses (an agent connected through
  // OAuth, one per client). Registration is open, so a client is only a name and its redirect
  // URIs; a code keeps only its hash and is consumed once.
  "0019_agent_connections": ddl(
    `CREATE TABLE oauth_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
      redirect_uris JSONB NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE machine_tokens
      ADD COLUMN purpose TEXT NOT NULL DEFAULT 'build' CHECK (purpose IN ('build', 'use')),
      ADD COLUMN oauth_client_id TEXT REFERENCES oauth_clients(id),
      ADD CONSTRAINT machine_tokens_use_client_check
        CHECK ((purpose = 'use') = (oauth_client_id IS NOT NULL))`
  )
};
