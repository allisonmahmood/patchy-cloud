# SQL

The shared metadata store and the schema changes its consumers own. Each capability owns its tables and migrations; SQL supplies the common database boundary and migration ledger.

## Language

**Migration**:
One schema step owned by a capability and applied once in the database's shared sequence; a refused batch advances none. A landed migration is not edited: a database that applied it never sees the edit.
_Avoid_: schema version, patch (that word is the product's), idempotent migration (they are not, by design)

**Ledger**:
The database's record of applied migrations, not the application version last run. Its highest applied id is the high-water mark: only higher ids are eligible, so lower-numbered gaps are not backfilled. Migrating refuses a ledger that disagrees with the record up to the lower of the two high-water marks: a database migrated by another history, such as one from before the baselines were squashed.
_Avoid_: migration history, version table

**Reported commit**:
A change run as the outermost transaction whose report runs with its COMMIT (`withReportedCommit`). The change stays cancellable, lock waits included; an interrupt during COMMIT waits until the committed change has reported, and a rolled-back change reports nothing.
_Avoid_: after-commit hook (nothing is registered; the report follows this transaction only)

**Baseline**:
A capability's first migration, creating its tables as they stood when it landed. The platform baselines were squashed before launch, one per capability.
_Avoid_: initial schema, snapshot
