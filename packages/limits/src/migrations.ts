import { ddl, type Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0009_limits_overrides": ddl(
    `CREATE TABLE limits_revisions (
      company_id TEXT PRIMARY KEY REFERENCES companies(id),
      revision BIGINT NOT NULL CHECK (revision > 0)
    )`,
    `CREATE TABLE limits_overrides (
      company_id TEXT NOT NULL REFERENCES companies(id),
      limit_id TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL CHECK (value > 0 AND value < 'Infinity'::float8),
      PRIMARY KEY (company_id, limit_id)
    )`,
    `CREATE TABLE limits_override_history (
      company_id TEXT NOT NULL REFERENCES companies(id),
      limit_id TEXT NOT NULL,
      revision BIGINT NOT NULL CHECK (revision > 0),
      deployment_revision TEXT NOT NULL CHECK (length(deployment_revision) > 0),
      old_value DOUBLE PRECISION NOT NULL CHECK (old_value > 0 AND old_value < 'Infinity'::float8),
      new_value DOUBLE PRECISION NOT NULL CHECK (new_value > 0 AND new_value < 'Infinity'::float8),
      old_override DOUBLE PRECISION CHECK (old_override > 0 AND old_override < 'Infinity'::float8),
      new_override DOUBLE PRECISION CHECK (new_override > 0 AND new_override < 'Infinity'::float8),
      actor TEXT NOT NULL CHECK (length(btrim(actor)) > 0),
      changed_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (company_id, revision)
    )`,
    `CREATE INDEX limits_override_history_limit_idx
      ON limits_override_history (company_id, limit_id, revision)`
  )
};
