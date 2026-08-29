/**
 * The sql capability: a Postgres client from config, and Effect's Migrator
 * over the migration records the capability packages own. This package owns
 * no tables; see CONTEXT.md for the migration contract and README.md for how
 * a capability decodes rows.
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as Migrator from "effect/unstable/sql/Migrator";

/** A capability's migrations: `<id>_<name>` keys over one global integer id sequence. */
export type Migrations = Parameters<typeof Migrator.fromRecord>[0];

/** The ledger Effect's Migrator keeps: `(migration_id integer, name, created_at)`. */
export const LEDGER_TABLE = "schema_migrations";

/** The client the server runs on: `DATABASE_URL`, read as a secret. */
export const layer = PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") });

/** The same client on a URL already in hand — the migration seam and the test layer. */
export const layerFromUrl = (url: Redacted.Redacted<string>) => PgClient.layer({ url });

/**
 * Applies every pending migration in one transaction under an `ACCESS
 * EXCLUSIVE` lock on the ledger, and answers with what it applied. Callers
 * spread the capability records into one: `migrate({ ...auth, ...patches })`.
 * Ids are sorted numerically and a duplicate fails with `MigrationError`
 * (`kind: "Duplicates"`) before anything runs.
 */
export const migrate = (migrations: Migrations) =>
  Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: LEDGER_TABLE });
