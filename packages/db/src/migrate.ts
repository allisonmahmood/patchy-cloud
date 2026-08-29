/**
 * The seam between this unported package and `@patchy/sql`: today's Postgres
 * steps as a Migrator record, run through Effect's Migrator from a Promise.
 * Deleted by the PRs that move the migrations into `auth` and `patches`.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Sql from "@patchy/sql";
import { SCHEMA_MIGRATIONS } from "./migrations.js";

/** Each `postgres` string runs whole through `sql.unsafe`; ids like `0001_baseline_schema` parse as `<id>_<name>`. */
const postgresMigrations: Sql.Migrations = Object.fromEntries(
  SCHEMA_MIGRATIONS.flatMap(({ id, postgres }) =>
    postgres === undefined
      ? []
      : [[id, Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(postgres))] as const]
  )
);

/** Brings the database at `databaseUrl` to the current schema. */
export function migrateDatabase(databaseUrl: string): Promise<void> {
  return Effect.runPromise(
    Sql.migrate(postgresMigrations).pipe(
      Effect.asVoid,
      Effect.provide(Sql.layerFromUrl(Redacted.make(databaseUrl)))
    )
  );
}
