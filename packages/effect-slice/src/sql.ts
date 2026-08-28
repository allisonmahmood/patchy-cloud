/**
 * The sql capability: a Postgres client from config, and a migrator that
 * composes migrations owned by other capability packages.
 */
import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Layer, Redacted } from "effect";
import { Migrator } from "effect/unstable/sql";
import { authMigrations } from "./auth/migrations.js";
import { patchMigrations } from "./patches/migrations.js";

export const PgLive = PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") });

export const pgLayerFor = (url: string) => PgClient.layer({ url: Redacted.make(url) });

/**
 * `Migrator.fromRecord` takes one record, so cross-package composition is a
 * spread. The migrator sorts by numeric id and refuses duplicate ids, which is
 * the only cross-package contract: ids are one global sequence.
 */
export const runMigrations = (migrations: Parameters<typeof Migrator.fromRecord>[0]) =>
  Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: "schema_migrations" });

export const allMigrations = { ...authMigrations, ...patchMigrations };

export const MigratorLive = Layer.effectDiscard(runMigrations(allMigrations).pipe(Effect.orDie));
