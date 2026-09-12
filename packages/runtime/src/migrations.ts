import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0006_runtime_baseline": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe(`
      CREATE TABLE runtime_calls (
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
        duration_ms INTEGER CHECK (duration_ms >= 0),
        row_count INTEGER CHECK (row_count >= 0),
        sql TEXT CHECK (sql IS NULL OR (op = 'postgres.query' AND octet_length(sql) <= 8192)),
        correlation_id TEXT NOT NULL UNIQUE,
        deadline_ms INTEGER NOT NULL DEFAULT 30000 CHECK (deadline_ms > 0),
        CHECK ((outcome = 'pending' AND duration_ms IS NULL AND row_count IS NULL)
          OR (outcome <> 'pending' AND duration_ms IS NOT NULL))
      );
    `)
  )
};
