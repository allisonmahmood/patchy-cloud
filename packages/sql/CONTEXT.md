# SQL

The Postgres client every capability package queries through, and the Migrator that brings a database to the schema those packages declare. `packages/sql` owns no tables: each capability owns its migrations and this package only composes and runs them.

## Language

**Migration**:
One schema step a capability package owns, keyed `<id>_<name>` in its migration record and run once through Effect's Migrator. Ids form one global sequence — Companies owns baseline 1, Auth 2 and Patches 3 — and duplicate ids fail before any step executes; pending steps run transactionally under an exclusive ledger lock, so a failure rolls the batch back.
_Avoid_: schema version, patch (that word is the product's), idempotent migration (they are not, by design)

**Ledger**:
The `schema_migrations` table Effect's Migrator keeps — `migration_id integer`, `name`, `created_at` — recording each applied migration. Reading it is how a database says where it stands; nothing else writes it.
_Avoid_: migration history, version table
