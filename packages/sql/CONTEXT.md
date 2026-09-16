# SQL

The shared metadata store and the schema changes its consumers own. Each capability owns its tables and migrations; SQL supplies the common database boundary and migration ledger.

## Language

**Migration**:
One schema step owned by a capability and applied once in the database's shared sequence; a refused batch advances none.
_Avoid_: schema version, patch (that word is the product's), idempotent migration (they are not, by design)

**Ledger**:
The database's record of applied migrations, not the application version last run. Its highest applied id is the high-water mark: only higher ids are eligible, so lower-numbered gaps are not backfilled.
_Avoid_: migration history, version table
