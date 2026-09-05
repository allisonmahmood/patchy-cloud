import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0001_companies_baseline": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL UNIQUE,
      company_id TEXT NOT NULL REFERENCES companies(id),
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deactivated_at TIMESTAMPTZ
    );
    CREATE INDEX users_company_id_idx ON users(company_id);

    CREATE TABLE invites (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      invited_by TEXT NOT NULL REFERENCES users(id),
      clerk_invitation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX invites_company_email_live_idx ON invites(company_id, email)
      WHERE revoked_at IS NULL AND consumed_at IS NULL;
  `)
  )
};
