import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0006_runtime_baseline": ddl(
    `CREATE TABLE runtime_calls (
      id TEXT PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Attribution is a snapshot, not a foreign key: deleting a patch,
      -- version, user or connection must neither erase nor anonymize a call.
      company_id TEXT NOT NULL,
      patch_id TEXT,
      version_id TEXT,
      user_id TEXT NOT NULL,
      credential_kind TEXT NOT NULL CHECK (credential_kind IN ('session', 'admin')),
      op TEXT NOT NULL,
      resource TEXT,
      connection_id TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'success', 'failure')),
      outcome_code TEXT,
      duration_ms INTEGER CHECK (duration_ms >= 0),
      row_count INTEGER CHECK (row_count >= 0),
      sql TEXT CHECK (sql IS NULL OR (op = 'postgres.query' AND octet_length(sql) <= 8192)),
      correlation_id TEXT NOT NULL UNIQUE,
      deadline_ms INTEGER NOT NULL DEFAULT 30000 CHECK (deadline_ms > 0),
      CHECK ((outcome = 'pending' AND duration_ms IS NULL AND row_count IS NULL)
        OR (outcome <> 'pending' AND duration_ms IS NOT NULL))
    )`,
    `CREATE INDEX runtime_calls_connection_recent
      ON runtime_calls (company_id, connection_id, at DESC, id DESC)`
  ),
  "0011_runtime_invocations": ddl(
    `ALTER TABLE runtime_calls
      ALTER COLUMN user_id DROP NOT NULL,
      ADD COLUMN effective_principal TEXT,
      ADD COLUMN invocation_id TEXT`,
    `UPDATE runtime_calls SET effective_principal = user_id`,
    `ALTER TABLE runtime_calls
      ALTER COLUMN effective_principal SET NOT NULL,
      DROP CONSTRAINT runtime_calls_outcome_check,
      ADD CONSTRAINT runtime_calls_outcome_check
        CHECK (outcome IN ('pending', 'unknown', 'success', 'handler_error', 'failure'))`,
    `CREATE INDEX runtime_calls_invocation
      ON runtime_calls (company_id, invocation_id, at, id)
      WHERE invocation_id IS NOT NULL`,
    `CREATE TABLE runtime_invocations (
      id TEXT PRIMARY KEY,
      -- Keep attribution after its source patch, version or viewer is deleted.
      company_id TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      handler TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('query', 'mutation', 'action')),
      initiating_viewer_id TEXT NOT NULL,
      effective_principal TEXT NOT NULL,
      parent_id TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK (outcome IN ('pending', 'success', 'handler_error', 'failure',
          'handler_timeout', 'unknown_outcome')),
      outcome_code TEXT,
      correlation_id TEXT NOT NULL UNIQUE,
      started_at TIMESTAMPTZ NOT NULL,
      deadline TIMESTAMPTZ NOT NULL CHECK (deadline >= started_at),
      settled_at TIMESTAMPTZ,
      duration_ms INTEGER CHECK (duration_ms >= 0),
      guest_ms INTEGER NOT NULL DEFAULT 0 CHECK (guest_ms >= 0),
      db_ms INTEGER NOT NULL DEFAULT 0 CHECK (db_ms >= 0),
      callbacks INTEGER NOT NULL DEFAULT 0 CHECK (callbacks >= 0),
      args_bytes INTEGER NOT NULL CHECK (args_bytes >= 0),
      result_bytes INTEGER NOT NULL DEFAULT 0 CHECK (result_bytes >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      log_lines JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(log_lines) = 'array'),
      reply_delivered BOOLEAN NOT NULL DEFAULT false,
      CHECK ((outcome = 'pending' AND settled_at IS NULL AND duration_ms IS NULL)
        OR (outcome <> 'pending' AND settled_at IS NOT NULL AND duration_ms IS NOT NULL))
    )`,
    `CREATE INDEX runtime_invocations_patch_recent
      ON runtime_invocations (company_id, patch_id, started_at DESC, id DESC)`,
    `CREATE INDEX runtime_invocations_parent
      ON runtime_invocations (company_id, parent_id, started_at, id)
      WHERE parent_id IS NOT NULL`,
    `CREATE TABLE runtime_query_rollups (
      company_id TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      handler TEXT NOT NULL,
      minute TIMESTAMPTZ NOT NULL
        CHECK (minute AT TIME ZONE 'UTC' = date_trunc('minute', minute AT TIME ZONE 'UTC')),
      runs BIGINT NOT NULL DEFAULT 0 CHECK (runs >= 0),
      re_runs BIGINT NOT NULL DEFAULT 0 CHECK (re_runs >= 0),
      failures BIGINT NOT NULL DEFAULT 0 CHECK (failures >= 0),
      guest_ms BIGINT NOT NULL DEFAULT 0 CHECK (guest_ms >= 0),
      db_ms BIGINT NOT NULL DEFAULT 0 CHECK (db_ms >= 0),
      callbacks BIGINT NOT NULL DEFAULT 0 CHECK (callbacks >= 0),
      args_bytes BIGINT NOT NULL DEFAULT 0 CHECK (args_bytes >= 0),
      result_bytes BIGINT NOT NULL DEFAULT 0 CHECK (result_bytes >= 0),
      PRIMARY KEY (company_id, patch_id, version_id, handler, minute)
    )`,
    `CREATE TABLE runtime_query_rollup_runs (
      run_id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX runtime_query_rollup_runs_applied
      ON runtime_query_rollup_runs (applied_at)`
  ),
  "0012_runtime_mutation_commit_proof": ddl(
    `ALTER TABLE runtime_invocations ADD COLUMN mutation_committed BOOLEAN NOT NULL DEFAULT false`
  )
};
