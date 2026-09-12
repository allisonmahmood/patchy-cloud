import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migrations } from "@patchy/sql";

export const migrations: Migrations = {
  "0005_company_database_baseline": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe(`
      CREATE TABLE company_databases (
        company_id TEXT PRIMARY KEY REFERENCES companies(id),
        server_id TEXT NOT NULL DEFAULT 'primary',
        database_name TEXT NOT NULL,
        placement_version INTEGER NOT NULL DEFAULT 1 CHECK (placement_version > 0),
        status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'ready')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ready_at TIMESTAMPTZ,
        UNIQUE (server_id, database_name),
        CHECK ((status = 'ready') = (ready_at IS NOT NULL))
      )
    `)
  )
};
