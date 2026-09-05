# SQL

The shared metadata store and the schema changes its consumers own. Each capability owns its tables and migrations; SQL supplies the common database boundary and migration ledger.

## Language

**Migration**:
One schema step owned by a capability and applied once in the database's shared sequence. Companies owns baseline 1, Auth 2 and Patches 3; a refused batch advances none of them.
_Avoid_: schema version, patch (that word is the product's), idempotent migration (they are not, by design)

**Ledger**:
The database's record of applied migrations. It identifies which schema steps have completed, rather than which application version last ran.
_Avoid_: migration history, version table
