# @patchy/sql

The `@effect/sql-pg` client layer, Effect's Migrator over the capability packages' migration records, and the migrated-database test layer. No tables live here; see `CONTEXT.md` for the migration and ledger contract.

- `layer` — `PgClient` from `DATABASE_URL` (a `Redacted` `Config`). `layerFromUrl` is the same client on a URL already in hand. Both use `pool`, which carries the row codecs below, keeps the pool on the wall clock, and refuses unsupported URL parameters (`UnsupportedUrlParameters`). The native driver sends protocol `CancelRequest`s rather than SQL cancellation, and removes dead sessions before lending connections again. Use direct connections with `sslmode=verify-full` on Neon; `channel_binding`, `ssl=true` and `statement_timeout` URL parameters are not supported and fail at startup rather than being ignored. PgBouncer remains unvalidated for named prepared statements and session behavior; see [ADR-0009](../../docs/adr/ADR-0009-one-postgres-database-per-company.md).
- `migrate({ ...companies, ...auth, ...patches, ...companyDatabase, ...runtime, ...integrations, ...limits, ...execution })` — runs every pending platform step in one transaction and answers with what it applied. The record keys are `<id>_<name>`; a record is `ddl(...statements)`, one statement per string, because the client's extended protocol takes one statement per query. Before running anything it compares the ledger with the record up to the lower of their highest ids and refuses a mismatch with `MigrationError` (`kind: "BadState"`), naming the id and both steps; ids above the record's highest pass, so an earlier build still starts. Company inventory initialization is separate and emits one statement per call so the same SQL runs over Postgres and PGlite.
- `@patchy/sql/testing` — `layer()` clones the shared seeded template for an `it.layer` block and drops the clone when the layer closes. `emptyLayer(migrations)` creates an empty database for SQL's own migrator tests.

## Decoding rows

A capability decodes rows through `SqlSchema` with a `Schema.Class` result, in one module per capability. The native `@effect/sql-pg` client decodes `int8` to `bigint` and timestamps to `Date` (a plain `timestamp` read as UTC wall time); the pool's row codecs keep `int8` as a decimal string, so rows answer the shapes PGlite answers in `@patchy/company-database`, and the override lives here rather than in every row schema:

```ts
class TokenRow extends Schema.Class<TokenRow>("TokenRow")({
  id: Schema.String,
  userId: Schema.String,
  revokedAt: Schema.NullOr(Schema.Date) // a Date, by way of the pool's row codecs
}) {}

const findToken = SqlSchema.findOneOption({
  Request: Schema.String,
  Result: TokenRow,
  execute: (hash) =>
    sql`SELECT id, user_id AS "userId", revoked_at AS "revokedAt" FROM machine_tokens WHERE token_hash = ${hash}`
});
```

Two error rules the capability module applies (`SqlSchema` itself fails with either): a `SchemaError` on a row is a bug in the query or the schema, never a caller's fault, so the module `Effect.die`s it at the decode; a `SqlError` stays in the failure channel and is caught where the policy lives (a best-effort visit stamp swallows it, an upload does not).

## Tests

```ts
import * as Testing from "@patchy/sql/testing";

it.layer(Testing.layer())("machine tokens", (it) => {
  it.effect("...", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient; /* ... */
    })
  );
});
```

Every package's `vitest.config.ts` re-exports `test/vitest.config.ts`, whose `globalSetup` starts the embedded cluster the test layer creates databases on.
