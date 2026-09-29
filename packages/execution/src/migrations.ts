import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0014_execution_fleet": ddl(
    `CREATE TABLE execution_deployments (
      revision TEXT PRIMARY KEY,
      ordinal INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
      retired BOOLEAN NOT NULL DEFAULT false
    )`,
    `CREATE TABLE execution_tasks (
      task_id TEXT PRIMARY KEY,
      deployment_revision TEXT NOT NULL REFERENCES execution_deployments(revision),
      state TEXT NOT NULL CHECK (state IN ('starting', 'spare', 'bound', 'stopping', 'stopped')),
      requested_at DOUBLE PRECISION NOT NULL,
      started_at DOUBLE PRECISION,
      ready_at DOUBLE PRECISION,
      stopped_at DOUBLE PRECISION
    )`,
    `CREATE INDEX execution_tasks_spares ON execution_tasks(deployment_revision, requested_at)
      WHERE state = 'spare'`,
    `CREATE SEQUENCE execution_binding_epochs AS INTEGER`,
    `CREATE TABLE execution_bindings (
      binding_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      binding_epoch INTEGER NOT NULL DEFAULT nextval('execution_binding_epochs') UNIQUE,
      company_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE REFERENCES execution_tasks(task_id),
      owner_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('claiming', 'active', 'stopping', 'stopped')),
      bound_at DOUBLE PRECISION NOT NULL,
      last_activity_at DOUBLE PRECISION NOT NULL,
      idle_since DOUBLE PRECISION,
      protected_until DOUBLE PRECISION NOT NULL DEFAULT 0,
      spare_wait_ms DOUBLE PRECISION NOT NULL CHECK (spare_wait_ms >= 0),
      peak_processes INTEGER NOT NULL DEFAULT 0 CHECK (peak_processes >= 0),
      release_cause TEXT
    )`,
    `CREATE UNIQUE INDEX execution_bindings_company_admission
      ON execution_bindings(company_id) WHERE state IN ('claiming', 'active')`,
    `CREATE TABLE execution_binding_history (
      binding_id INTEGER PRIMARY KEY REFERENCES execution_bindings(binding_id),
      binding_epoch INTEGER NOT NULL,
      company_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      deployment_revision TEXT NOT NULL,
      bound_at DOUBLE PRECISION NOT NULL,
      released_at DOUBLE PRECISION,
      bound_seconds DOUBLE PRECISION CHECK (bound_seconds >= 0),
      spare_wait_ms DOUBLE PRECISION NOT NULL,
      peak_processes INTEGER NOT NULL DEFAULT 0,
      release_cause TEXT,
      event_emitted BOOLEAN NOT NULL DEFAULT false
    )`,
    `CREATE TABLE execution_housekeeping (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
      owner_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL,
      expires_at DOUBLE PRECISION NOT NULL
    )`,
    `CREATE TABLE execution_processes (
      report_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES execution_tasks(task_id),
      binding_id INTEGER NOT NULL REFERENCES execution_bindings(binding_id),
      binding_epoch INTEGER NOT NULL,
      company_id TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      process_generation INTEGER NOT NULL,
      started_at DOUBLE PRECISION NOT NULL,
      ended_at DOUBLE PRECISION NOT NULL,
      cause TEXT NOT NULL,
      cpu_seconds DOUBLE PRECISION NOT NULL CHECK (cpu_seconds >= 0),
      peak_rss_bytes DOUBLE PRECISION NOT NULL CHECK (peak_rss_bytes >= 0),
      calls_served INTEGER NOT NULL CHECK (calls_served >= 0),
      report JSONB NOT NULL,
      UNIQUE(task_id, binding_epoch, process_generation)
    )`,
    `CREATE TABLE execution_breakers (
      company_id TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      publish_revision BIGINT NOT NULL DEFAULT 0,
      reset_at DOUBLE PRECISION NOT NULL DEFAULT 0,
      paused_until DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY(company_id, patch_id)
    )`,
    `CREATE TABLE execution_breaker_kills (
      report_id TEXT PRIMARY KEY REFERENCES execution_processes(report_id),
      company_id TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      killed_at DOUBLE PRECISION NOT NULL,
      publish_revision BIGINT NOT NULL
    )`,
    `CREATE INDEX execution_breaker_kills_window
      ON execution_breaker_kills(company_id, patch_id, publish_revision, killed_at)`
  )
};
