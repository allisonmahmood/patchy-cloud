# @patchy/sql

The `@effect/sql-pg` client layer, Effect's Migrator over the capability packages' migration records, and the migrated-database test layer. No tables live here; see `CONTEXT.md` for the migration and ledger contract.

- `layer` — `PgClient` from `DATABASE_URL` (a `Redacted` `Config`). `layerFromUrl` is the same client on a URL already in hand. Connections are direct: the pinned adapter's cancellation does not work through PgBouncer's transaction pooling; see [ADR-0009](../../docs/adr/ADR-0009-one-postgres-database-per-company.md).
- `migrate({ ...companies, ...auth, ...patches, ...companyDatabase, ...runtime })` — runs every pending platform step in one transaction and answers with what it applied. The record keys are `<id>_<name>`; existing platform migrations use multi-statement DDL. Company inventory initialization is separate and emits one statement per call so the same SQL runs over Postgres and PGlite.
- `@patchy/sql/testing` — `layer()` clones the shared seeded template for an `it.layer` block and drops the clone when the layer closes. `emptyLayer(migrations)` creates an empty database for SQL's own migrator tests.

## Decoding rows

A capability decodes rows through `SqlSchema` with a `Schema.Class` result, in one module per capability, so the pending `@effect/sql-pg` client type change (`int8` → `bigint`, timestamps → epoch milliseconds) lands in one place per package:

```ts
class TokenRow extends Schema.Class<TokenRow>("TokenRow")({
  id: Schema.String,
  userId: Schema.String,
  revokedAt: Schema.NullOr(Schema.Date) // today's client hands back a Date; when it becomes epoch ms only this line moves
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
