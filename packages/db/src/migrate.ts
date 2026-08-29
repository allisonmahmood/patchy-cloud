/**
 * The seam between this unported package and `@patchy/sql`: `@patchy/auth`'s
 * migrations plus today's draft steps as one Migrator record, run through
 * Effect's Migrator from a Promise. Deleted by the PR that moves the draft
 * migrations into `patches`.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrations as authMigrations } from "@patchy/auth";
import { layerFromUrl, migrate, type Migrations } from "@patchy/sql";
import { SCHEMA_MIGRATIONS } from "./migrations.js";

/** Each `postgres` string runs whole through `sql.unsafe`; ids like `0003_drafts_baseline` parse as `<id>_<name>`. */
const postgresMigrations: Migrations = Object.fromEntries(
  SCHEMA_MIGRATIONS.flatMap(({ id, postgres }) =>
    postgres === undefined
      ? []
      : [[id, Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(postgres))] as const]
  )
);

/** Brings the database at `databaseUrl` to the current schema. */
export function migrateDatabase(databaseUrl: string): Promise<void> {
  return Effect.runPromise(
    migrate({ ...authMigrations, ...postgresMigrations }).pipe(
      Effect.asVoid,
      Effect.provide(layerFromUrl(Redacted.make(databaseUrl)))
    )
  );
}
