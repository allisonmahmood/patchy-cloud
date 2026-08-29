/**
 * The migration seam: every capability's migration record as one, run
 * through Effect's Migrator from a Promise for the code the port has not
 * reached — the Fastify server's startup, the dev runner and the vitest
 * template database. Deleted by the PR that moves the server onto Effect.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { migrations as authMigrations } from "@patchy/auth";
import { migrations as patchesMigrations } from "@patchy/patches";
import { layerFromUrl, migrate, type Migrations } from "@patchy/sql";

/** `auth` (ids 1–2) then `patches` (3 onward): one global sequence. */
export const migrations: Migrations = { ...authMigrations, ...patchesMigrations };

/** Brings the database at `databaseUrl` to the current schema. */
export function migrateDatabase(databaseUrl: string): Promise<void> {
  return Effect.runPromise(
    migrate(migrations).pipe(
      Effect.asVoid,
      Effect.provide(layerFromUrl(Redacted.make(databaseUrl)))
    )
  );
}
