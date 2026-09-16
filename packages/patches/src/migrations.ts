/**
 * The patches capability's schema: baseline 3 and lifecycle migration 8 of
 * the global migration sequence (`packages/sql/CONTEXT.md`).
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

const ddl = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement));

export const migrations: Migrations = {
  // A patch owns its address and served-version pointer. Versions retain
  // immutable bundles, manifests, contract versions and publish replay records.
  "0003_patches_baseline": ddl(`
    CREATE TABLE patches (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      scope TEXT NOT NULL DEFAULT 'company' CHECK (scope IN ('company', 'public')),
      title TEXT NOT NULL,
      name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
      current_version_id TEXT,
      repo_org TEXT,
      repo_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ,
      disabled_reason TEXT
    );

    CREATE TABLE patch_names (
      company_id TEXT NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
      patch_id TEXT NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
      current BOOLEAN NOT NULL
    );
    CREATE UNIQUE INDEX patch_names_company_name_idx ON patch_names(company_id, name);
    CREATE INDEX patch_names_patch_id_idx ON patch_names(patch_id);

    CREATE TABLE patch_versions (
      id TEXT PRIMARY KEY,
      patch_id TEXT NOT NULL REFERENCES patches(id),
      version_number INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_by_machine_token_id TEXT NOT NULL REFERENCES machine_tokens(id),
      source_ip TEXT,
      user_agent TEXT,
      cli_version TEXT,
      git_branch TEXT,
      git_commit_sha TEXT,
      original_filename TEXT,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
      release TEXT NOT NULL,
      manifest_version INTEGER NOT NULL,
      wire_version INTEGER NOT NULL,
      schema_revision INTEGER NOT NULL,
      manifest JSONB NOT NULL,
      publish_key TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      publish_response JSONB NOT NULL,
      publish_status INTEGER NOT NULL CHECK (publish_status IN (200, 201)),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (patch_id, version_number)
    );

    CREATE TABLE pending_patch_objects (
      object_key TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      claimed BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX pending_patch_objects_expiry_idx ON pending_patch_objects(expires_at);
    CREATE UNIQUE INDEX patch_versions_object_key_idx ON patch_versions(object_key);

    CREATE INDEX patches_company_id_idx ON patches(company_id);
    CREATE INDEX patches_owner_user_id_idx ON patches(owner_user_id);
    CREATE INDEX patch_versions_patch_id_idx ON patch_versions(patch_id);
    CREATE UNIQUE INDEX patch_versions_owner_publish_key_idx ON patch_versions(owner_user_id, publish_key);
  `),
  "0008_patches_lifecycle": ddl(`
    -- Deletes before this migration were irreversible and released their names.
    -- Finalize those tombstones rather than offer restore at a reused address
    -- or revive a namespace the old orphan sweep may already have removed.
    INSERT INTO pending_patch_objects (object_key, expires_at, claimed)
      SELECT versions.object_key, CURRENT_TIMESTAMP, false
      FROM patch_versions versions JOIN patches ON patches.id = versions.patch_id
      WHERE patches.deleted_at IS NOT NULL
      ON CONFLICT (object_key) DO UPDATE
        SET expires_at = EXCLUDED.expires_at, claimed = false;
    DELETE FROM patch_versions
      WHERE patch_id IN (SELECT id FROM patches WHERE deleted_at IS NOT NULL);
    DELETE FROM patches WHERE deleted_at IS NOT NULL;

    ALTER TABLE patches
      DROP COLUMN expires_at,
      ADD COLUMN retired_at TIMESTAMPTZ,
      ADD COLUMN retired_by TEXT REFERENCES users(id),
      ADD COLUMN deleted_by TEXT REFERENCES users(id),
      ADD COLUMN reassigned_at TIMESTAMPTZ,
      ADD COLUMN reassigned_by TEXT REFERENCES users(id),
      ADD COLUMN description TEXT NOT NULL DEFAULT '',
      ADD COLUMN description_updated_at TIMESTAMPTZ,
      ADD COLUMN description_updated_by TEXT REFERENCES users(id),
      ADD COLUMN last_changed_at TIMESTAMPTZ,
      ADD COLUMN last_changed_by TEXT REFERENCES users(id),
      ADD COLUMN last_changed_action TEXT,
      ADD COLUMN visit_count BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX patches_deleted_at_idx ON patches(deleted_at)
      WHERE deleted_at IS NOT NULL;
  `)
};
