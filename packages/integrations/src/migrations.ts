import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0007_integrations_baseline": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe(`
      CREATE TABLE connections (
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
      );

      -- Deliberately not a foreign key to connections: deleting a connection
      -- never erases a stored contract, including contracts no version names.
      CREATE TABLE connection_snapshots (
        connection_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        snapshot JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (connection_id, revision)
      );

      CREATE FUNCTION reject_connection_snapshot_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'connection snapshots are immutable';
      END;
      $$;
      CREATE TRIGGER connection_snapshots_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON connection_snapshots
        FOR EACH STATEMENT EXECUTE FUNCTION reject_connection_snapshot_mutation();
    `)
  )
};
