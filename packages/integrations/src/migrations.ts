/**
 * Company connections and their immutable schema snapshots: the baseline is id 6
 * in the global migration sequence, squashed before launch; later steps follow it.
 */
import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0006_integrations": ddl(
    `CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      integration TEXT NOT NULL CHECK (integration = 'postgres'),
      handle TEXT NOT NULL CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
      description TEXT NOT NULL CHECK (length(description) <= 500 AND description !~ E'[\\r\\n]'),
      mode TEXT NOT NULL CHECK (mode = 'company'),
      status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
      display JSONB NOT NULL,
      credentials TEXT NOT NULL,
      key_id TEXT NOT NULL,
      credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
      metadata_revision INTEGER NOT NULL CHECK (metadata_revision > 0),
      created_by TEXT NOT NULL,
      last_tested_at TIMESTAMPTZ,
      last_discovered_at TIMESTAMPTZ,
      UNIQUE (company_id, handle)
    )`,
    // Deliberately not a foreign key to connections: deleting a connection
    // never erases a stored contract, including contracts no version names.
    `CREATE TABLE connection_snapshots (
      connection_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (connection_id, revision)
    )`,
    `CREATE FUNCTION reject_connection_snapshot_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'connection snapshots are immutable';
    END;
    $$`,
    `CREATE TRIGGER connection_snapshots_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON connection_snapshots
      FOR EACH STATEMENT EXECUTE FUNCTION reject_connection_snapshot_mutation()`
  ),
  // A snapshot names its integration itself, since it outlives its connection. Each
  // release must work against the schema the next one leaves (docs/OPERATIONS.md), and
  // the release before this one omits the snapshot's integration, so the column keeps a
  // default; filling existing rows that way needs no UPDATE, which the immutability
  // trigger would refuse. Handles stay unique per company until the step that admits a
  // second integration swaps that key for one per integration: two handle keys at once
  // would let concurrent connects fail on the key their ON CONFLICT does not name.
  "0011_connections_per_integration": ddl(
    `ALTER TABLE connections DROP CONSTRAINT connections_integration_check`,
    `ALTER TABLE connection_snapshots ADD COLUMN integration TEXT NOT NULL DEFAULT 'postgres'`
  ),
  // PostHog arrives, so a handle is unique within its integration: postgres/warehouse and
  // posthog/warehouse may both exist. One statement swaps the keys, so the two never hold at
  // once. The release before this one connects with a targetless ON CONFLICT and names every
  // snapshot's integration, so it works against both changes.
  "0013_handles_per_integration": ddl(
    `ALTER TABLE connections
      DROP CONSTRAINT connections_company_id_handle_key,
      ADD CONSTRAINT connections_company_id_integration_handle_key
        UNIQUE (company_id, integration, handle)`,
    `ALTER TABLE connection_snapshots ALTER COLUMN integration DROP DEFAULT`
  ),
  // Each Pidgeon connection's sends and replies per UTC day, counted before Pidgeon sees one, so
  // the daily budget holds across processes and restarts. Rows go with their connection.
  "0028_pidgeon_sends": ddl(
    `CREATE TABLE pidgeon_sends (
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      sends INTEGER NOT NULL CHECK (sends > 0),
      PRIMARY KEY (connection_id, day)
    )`
  ),
  // An admin may keep guests off a connection: patches that declare it turn their guests away
  // while it's set. Every existing connection allows guests, as a new one does.
  "0032_connections_block_guests": ddl(
    `ALTER TABLE connections ADD COLUMN block_guests BOOLEAN NOT NULL DEFAULT false`
  ),
  // Who may build with a connection: the company, as every existing connection stays, or the
  // teams it names.
  "0041_connection_audiences": ddl(
    `ALTER TABLE connections ADD COLUMN audience_kind TEXT NOT NULL DEFAULT 'company' CHECK (audience_kind IN ('company', 'teams'))`,
    `CREATE TABLE connection_team_grants (
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      PRIMARY KEY(connection_id, team_id),
      FOREIGN KEY(company_id, team_id) REFERENCES company_teams(company_id, id)
    )`,
    `CREATE INDEX connection_team_references ON connection_team_grants(company_id, team_id)`
  ),
  // GitHub, through a GitHub App. An installation's parent row outlives every claim on it: it
  // keeps the cooldown a limit answer set and when a mint last found the App suspended, and is
  // what every claim, release, Resume and Reconnect locks first. Claims name which company holds
  // an installation; one company per installation is a check in code, not a key, so a second can
  // be admitted later. A flow record is one admin's sign-in to GitHub while choosing
  // repositories: a hashed nonce consumed once, the PKCE verifier, and the person's sealed token
  // once GitHub signed them in. It goes when the connection saves or it expires.
  "0043_github": ddl(
    `CREATE TABLE github_installations (
      installation_id BIGINT PRIMARY KEY CHECK (installation_id > 0),
      cooldown_until TIMESTAMPTZ,
      suspended_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE github_installation_claims (
      installation_id BIGINT NOT NULL REFERENCES github_installations(installation_id),
      company_id TEXT NOT NULL REFERENCES companies(id),
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (installation_id, company_id)
    )`,
    `CREATE TABLE github_flows (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      user_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'add', 'reconnect')),
      connection_id TEXT,
      nonce_hash TEXT NOT NULL UNIQUE,
      nonce_consumed_at TIMESTAMPTZ,
      verifier TEXT NOT NULL,
      github_user_id BIGINT,
      github_login TEXT,
      token TEXT,
      key_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (company_id, user_id),
      CHECK ((purpose = 'connect') = (connection_id IS NULL))
    )`,
    `CREATE INDEX github_flows_expiry ON github_flows(expires_at)`
  ),
  // Pidgeon's new API. What the old integration left can't be read by this release: a connection
  // keeps the old display and credentials, which would fail its company's whole connection list,
  // and a snapshot is version 1. Neither could work on the new API, so both go: the connections
  // with what hangs off them (their day counts and team grants, by their foreign keys), and every
  // Pidgeon snapshot, past the immutability trigger for this one statement. A patch version that
  // declares one keeps its manifest, and its calls are refused as through any connection that
  // isn't there; its patch works again once republished against a new connection.
  //
  // Then each Pidgeon connection's emails by draft key (a hash of the connection, the patch and
  // the patch's key): the Pidgeon draft that is the email, how far it got, and the claim of the
  // worker sending it. Pidgeon doesn't dedupe sends, so this row is what makes a draft key one
  // email. Rows go with their connection.
  "0044_pidgeon_drafts": ddl(
    `DELETE FROM connections WHERE integration = 'pidgeon'`,
    `ALTER TABLE connection_snapshots DISABLE TRIGGER connection_snapshots_immutable`,
    `DELETE FROM connection_snapshots WHERE integration = 'pidgeon'`,
    `ALTER TABLE connection_snapshots ENABLE TRIGGER connection_snapshots_immutable`,
    `CREATE TABLE pidgeon_drafts (
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      draft TEXT NOT NULL,
      digest TEXT NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('writing', 'drafted', 'sending', 'sent', 'held', 'refused')),
      draft_id TEXT,
      message_id TEXT,
      thread_id TEXT,
      owner TEXT,
      claimed_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ,
      PRIMARY KEY (connection_id, draft),
      CHECK ((owner IS NULL) = (claimed_until IS NULL))
    )`
  ),
  // Models: a provider is a connection holding the company's key for one model provider, and a
  // role is a `models` connection mapped here to one provider of its own company and a model id.
  // The mapping is a reference, so a provider a role points at can't be deleted, and it goes with
  // its role. Rows of both are new integrations, which the release before this one never reads.
  //
  // The key the mapping references takes `connections`' exclusive lock to build, as
  // `users_company_identity` did `users`'. Waiting for it behind a long transaction would queue
  // every connection read behind the migration, so the step gives up after three seconds: the
  // whole batch rolls back, the host stops before it listens, the hosts already running keep
  // serving, and ECS starts it again, rolling the deploy back if it keeps failing. The timeout
  // ends with the step.
  "0045_model_roles": ddl(
    `SET LOCAL lock_timeout = '3s'`,
    `ALTER TABLE connections ADD CONSTRAINT connections_company_id_id_key UNIQUE (company_id, id)`,
    `CREATE TABLE model_roles (
      connection_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('decision', 'text')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
      FOREIGN KEY (company_id, connection_id) REFERENCES connections(company_id, id) ON DELETE CASCADE,
      FOREIGN KEY (company_id, provider_id) REFERENCES connections(company_id, id) ON DELETE RESTRICT
    )`,
    `CREATE INDEX model_roles_provider ON model_roles(company_id, provider_id)`,
    `SET LOCAL lock_timeout TO DEFAULT`
  )
};
