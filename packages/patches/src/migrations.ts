/**
 * The patches capability's schema, id 3 in the global migration sequence
 * (`packages/sql/CONTEXT.md`). Squashed into one baseline before launch.
 */
import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  // A patch owns its address, served-version pointer, lifecycle and actor stamps.
  // Versions retain immutable bundles, manifests, contract versions and publish replay records.
  "0003_patches": ddl(
    `CREATE TABLE patches (
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
    deleted_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,
    disabled_reason TEXT,
    retired_at TIMESTAMPTZ,
    retired_by TEXT REFERENCES users(id),
    deleted_by TEXT REFERENCES users(id),
    reassigned_at TIMESTAMPTZ,
    reassigned_by TEXT REFERENCES users(id),
    description TEXT NOT NULL DEFAULT '',
    description_updated_at TIMESTAMPTZ,
    description_updated_by TEXT REFERENCES users(id),
    last_changed_at TIMESTAMPTZ,
    last_changed_by TEXT REFERENCES users(id),
    last_changed_action TEXT,
    visit_count BIGINT NOT NULL DEFAULT 0,
    lifecycle_revision BIGINT NOT NULL DEFAULT 0 CHECK (lifecycle_revision >= 0)
    )`,
    `CREATE TABLE patch_names (
    company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
    patch_id TEXT NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
    current BOOLEAN NOT NULL
    )`,
    `CREATE UNIQUE INDEX patch_names_company_name_idx ON patch_names(company_id, name)`,
    `CREATE INDEX patch_names_patch_id_idx ON patch_names(patch_id)`,
    `CREATE TABLE patch_versions (
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
    server_object_key TEXT,
    server_content_hash TEXT,
    server_file_size INTEGER,
    UNIQUE (patch_id, version_number),
    CONSTRAINT patch_versions_server_artifact CHECK (
      (server_object_key IS NULL AND server_content_hash IS NULL AND server_file_size IS NULL)
      OR (server_object_key IS NOT NULL AND server_content_hash IS NOT NULL
        AND server_file_size IS NOT NULL AND server_file_size >= 0)
    )
    )`,
    `CREATE TABLE pending_patch_objects (
    object_key TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    claimed BOOLEAN NOT NULL DEFAULT false
    )`,
    `CREATE INDEX pending_patch_objects_expiry_idx ON pending_patch_objects(expires_at)`,
    `CREATE UNIQUE INDEX patch_versions_object_key_idx ON patch_versions(object_key)`,
    `CREATE INDEX patches_company_id_idx ON patches(company_id)`,
    `CREATE INDEX patches_owner_user_id_idx ON patches(owner_user_id)`,
    `CREATE INDEX patch_versions_patch_id_idx ON patch_versions(patch_id)`,
    `CREATE UNIQUE INDEX patch_versions_owner_publish_key_idx ON patch_versions(owner_user_id, publish_key)`,
    `CREATE INDEX patches_deleted_at_idx ON patches(deleted_at)
    WHERE deleted_at IS NOT NULL`,
    `CREATE UNIQUE INDEX patch_versions_server_object_key_idx
    ON patch_versions(server_object_key) WHERE server_object_key IS NOT NULL`
  ),
  "0010_patch_agent_access": ddl(
    `CREATE TABLE patch_agent_access (
      patch_id TEXT PRIMARY KEY REFERENCES patches(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('read-only', 'actions')),
      handlers JSONB NOT NULL CHECK (jsonb_typeof(handlers) = 'array'),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      changed_by TEXT NOT NULL REFERENCES users(id),
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE patch_agent_grants (
      patch_id TEXT NOT NULL REFERENCES patch_agent_access(patch_id) ON DELETE CASCADE,
      machine_id TEXT NOT NULL REFERENCES machine_tokens(id) ON DELETE CASCADE,
      granted_by TEXT NOT NULL REFERENCES users(id),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (patch_id, machine_id)
    )`
  )
};
