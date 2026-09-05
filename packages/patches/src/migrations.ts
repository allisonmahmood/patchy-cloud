/**
 * The patches capability's schema: id 3 of the global migration sequence
 * (`packages/sql/CONTEXT.md`), the baseline for `patches` and
 * `patch_versions`. `auth` holds 1 and 2, which these tables reference.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

const ddl = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement));

export const migrations: Migrations = {
  // A patch is the runtime-agnostic record: who holds it, what it is called,
  // which version serves, and the clocks that decide whether it is up —
  // the retention anchor (`expires_at`), and the deleted / disabled stamps
  // that take it out of service. A version is one upload: the object key its
  // bytes sit under, and where the upload came from.
  "0003_patches_baseline": ddl(`
    CREATE TABLE patches (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      title TEXT NOT NULL,
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

    CREATE TABLE patch_versions (
      id TEXT PRIMARY KEY,
      patch_id TEXT NOT NULL REFERENCES patches(id),
      version_number INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_by_api_token_id TEXT NOT NULL REFERENCES api_tokens(id),
      source_ip TEXT,
      user_agent TEXT,
      cli_version TEXT,
      git_branch TEXT,
      git_commit_sha TEXT,
      original_filename TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (patch_id, version_number)
    );

    CREATE INDEX patches_account_id_idx ON patches(account_id);
    CREATE INDEX patch_versions_patch_id_idx ON patch_versions(patch_id);
  `)
};
