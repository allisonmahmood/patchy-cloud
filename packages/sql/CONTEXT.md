# SQL

The Postgres client every capability package queries through, and the Migrator that brings a database to the schema those packages declare. `packages/sql` owns no tables: each capability owns its migrations and this package only composes and runs them.

## Language

**Migration**:
One schema step a capability package owns, keyed `<id>_<name>` in that package's migration record and run once through Effect's Migrator. Ids form one global integer sequence across every package — `auth` takes 1–2, `patches` 3 onward — so a duplicate id anywhere fails the whole run before any step executes. Every pending step runs in one transaction under an `ACCESS EXCLUSIVE` lock on the ledger; a failing step rolls the batch back. Steps are plain DDL: the ledger is the guard, so no `IF NOT EXISTS`.
_Avoid_: schema version, patch (that word is the product's), idempotent migration (they are not, by design)

**Ledger**:
The `schema_migrations` table Effect's Migrator keeps — `migration_id integer`, `name`, `created_at` — recording each applied migration. Reading it is how a database says where it stands; nothing else writes it.
_Avoid_: migration history, version table

**Migration seam**:
`migrateDatabase` in `packages/db/src/migrate.ts`: the Promise adapter that runs today's migrations through the Migrator for the server, the dev runner and the vitest template database, until the `auth` and `patches` packages take the migrations and the seam goes.
