# @patchy/sql

The `@effect/sql-pg` client layer, Effect's Migrator over the capability packages' migration records, and the migrated-database test layer. No tables live here; see `CONTEXT.md` for the migration and ledger contract.

- `layer` — `PgClient` from `DATABASE_URL` (a `Redacted` `Config`). `layerFromUrl` is the same client on a URL already in hand.
- `migrate({ ...auth, ...patches })` — runs every pending step in one transaction and answers with what it applied. The record keys are `<id>_<name>`; a multi-statement DDL string runs through `sql.unsafe`.
- `@patchy/sql/testing` — `layer(migrations)`: an `it.layer` block gets a fresh database on the vitest cluster, migrated by the record, dropped with the layer.

## Decoding rows

A capability decodes rows through `SqlSchema` with a `Schema.Class` result, in one module per capability, so the pending `@effect/sql-pg` client type change (`int8` → `bigint`, timestamps → epoch milliseconds) lands in one place per package:

```ts
class TokenRow extends Schema.Class<TokenRow>("TokenRow")({
  id: Schema.String,
  accountId: Schema.String,
  revokedAt: Schema.NullOr(Schema.Date)
}) {}

const findToken = SqlSchema.findOneOption({
  Request: Schema.String,
  Result: TokenRow,
  execute: (hash) =>
    sql`SELECT id, account_id AS "accountId", revoked_at AS "revokedAt" FROM api_tokens WHERE token_hash = ${hash}`
});
```

Two error rules: a `SchemaError` on a row is a bug in the query or the schema, never a caller's fault, so it is `Effect.die`d at the decode; a `SqlError` stays in the failure channel and is caught where the policy lives (a best-effort visit stamp swallows it, an upload does not).

## Tests

```ts
import * as Testing from "@patchy/sql/testing";

it.layer(Testing.layer({ ...authMigrations, ...patchMigrations }))("tokens", (it) => {
  it.effect("...", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient; /* ... */
    })
  );
});
```

Every package's `vitest.config.ts` re-exports `test/vitest.config.ts`, whose `globalSetup` starts the embedded cluster the test layer creates databases on.
