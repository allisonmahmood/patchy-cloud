/**
 * The execution fleet: deployments, tasks, bindings, process reports, breakers
 * and the housekeeping lease, id 8 in the global migration sequence. Squashed
 * into one baseline before launch; later changes take their own ids.
 */
import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0008_execution": ddl(
    `CREATE TABLE execution_deployments (
      revision TEXT PRIMARY KEY,
      retired BOOLEAN NOT NULL DEFAULT false
    )`,
    `CREATE TABLE execution_rollout (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
      current_revision TEXT REFERENCES execution_deployments(revision),
      staged_revision TEXT REFERENCES execution_deployments(revision)
    )`,
    `INSERT INTO execution_rollout(singleton) VALUES (true)`,
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
  ),
  // Agent idle: a binding's second clock, from an agent's last call settling, beside the
  // documents' `last_activity_at` and `idle_since`, which an agent-only binding leaves at 0 and
  // null. History records whether a released binding was agent-only; earlier rows say nothing.
  "0025_agent_idle": ddl(
    `ALTER TABLE execution_bindings ADD COLUMN agent_activity_at DOUBLE PRECISION NOT NULL DEFAULT 0`,
    `ALTER TABLE execution_binding_history ADD COLUMN agent_only BOOLEAN`
  ),
  // Cold companies waiting on an empty spare pool, one row per company so duplicate waiters
  // collapse and housekeeping counts them alongside the wake rate.
  "0046_execution_pool_waits": ddl(
    `CREATE TABLE execution_pool_waits (
      company_id TEXT PRIMARY KEY,
      until DOUBLE PRECISION NOT NULL
    )`
  ),
  // Box sizes: a task's CPU units and MiB, requested while it starts and verified once it is
  // ready; the size a waiting company needs; the switch that lets a one-member company run on a
  // small box. `unrefused_launches` counts a task's launch attempts not refused outright, each
  // counted before it is sent: 0 means nothing was ever launched for it, so a drain can complete
  // without a task to stop. A small reservation sets 0; null means unknown, as for a full
  // reservation, existing rows, an older host's inserts and any row whose task was seen running.
  // Every size default is today's full box, so existing rows and an older host's inserts stay
  // correct. No step rewrites or scans a table: each default is a constant, kept in the catalog,
  // and the count's check is added NOT VALID, binding new writes without reading every task row
  // ever made, whose counts are all null.
  //
  // It locks first. Hosts of the previous release keep running fleet transactions while it runs,
  // taking these tables in other orders: a replacement locks the rollout row and then touches the
  // tasks, a claim touches the tasks and reads the rollout. Altering one table at a time would hold
  // one exclusive lock while waiting for the next, and could deadlock with either. So the first
  // statement takes all three without ever waiting while it holds one: NOWAIT, and a try that
  // fails leaves its exception block, which releases whatever that try took, before it sleeps
  // and tries again. Locks taken in a block that completes last to the end of the transaction.
  // If the tables stay busy for about ten seconds it fails, the batch applies nothing, and the
  // deploy is run again.
  "0047_execution_box_sizes": ddl(
    `DO $$
    BEGIN
      FOR attempt IN 1..100 LOOP
        BEGIN
          LOCK TABLE execution_rollout, execution_tasks, execution_pool_waits
            IN ACCESS EXCLUSIVE MODE NOWAIT;
          RETURN;
        EXCEPTION WHEN lock_not_available THEN
          PERFORM pg_sleep(0.1);
        END;
      END LOOP;
      RAISE EXCEPTION 'The execution fleet tables stayed busy for 10 seconds, so migration 0047 applied nothing. Run the deploy again.'
        USING ERRCODE = 'lock_not_available';
    END
    $$`,
    `ALTER TABLE execution_tasks ADD COLUMN cpu INTEGER NOT NULL DEFAULT 1024`,
    `ALTER TABLE execution_tasks ADD COLUMN memory INTEGER NOT NULL DEFAULT 2048`,
    `ALTER TABLE execution_tasks ADD COLUMN unrefused_launches INTEGER`,
    `ALTER TABLE execution_tasks ADD CONSTRAINT execution_tasks_unrefused_launches_check
      CHECK (unrefused_launches >= 0) NOT VALID`,
    `ALTER TABLE execution_pool_waits ADD COLUMN cpu INTEGER NOT NULL DEFAULT 1024`,
    `ALTER TABLE execution_rollout ADD COLUMN small_boxes BOOLEAN NOT NULL DEFAULT false`
  )
};
