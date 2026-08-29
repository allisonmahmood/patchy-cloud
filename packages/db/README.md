# @patchy/db

The metadata store behind the hosting context, with two drivers: `postgres` for
deployed instances and `json` for a single-file store. Both implement the same
`PatchyDb` port and are held to the same driver-parametrized contract suite
in `src/upload-contract.test.ts`.

## The retention clock

Every draft carries one expiry anchor, `expiresAt`, and `src/retention.ts` owns
the rules that act on it: an upload restarts the full window, a visit tops the
remaining time up to the visit window when less than that remains, a draft is
expired the moment `expiresAt` is past — and a **pinned** draft (`pinnedAt` set)
is never expired, however far past its anchor now is. `isExpired` is the one
answer everything keys on, and it needs no term for deleted or disabled drafts
because a pin only ever sits on a draft in service: `deleteDraft` and
`disableDraft` clear the pin, and `setDraftPinned` refuses to pin a draft that is
already deleted or disabled — while unpinning takes any row still there, so a pin
can never be stuck on a draft the operator has since taken down. Without that
invariant, a pinned-then-deleted draft would be exempt from the sweep forever.
Expired drafts are absent from `findDraftVersion` and
refused as update targets, exactly as deleted and disabled ones are; the row
itself stays until the sweep removes it.

## The expiry sweep

Expiry is a hard delete, and `listExpiredDraftIds` plus `deleteExpiredDraft` are
how it happens: the first names drafts whose clock has run out with no pin on
them, the second takes one — its upload events, its versions, and the draft row,
in the order the foreign keys require — and answers with the storage keys those
versions held so the caller can delete the content too. There is no recovery.

The record goes before the content on purpose. Once the row is gone its objects
are unreachable, so a failure between the two leaks storage; the other order
risks a live draft whose content vanished. `deleteExpiredDraft` re-checks expiry
under a row lock, so a pin landing mid-sweep saves the draft rather than racing
it, and answers `null` when there was nothing to take.

The sweep is what frees storage _and_ quota in one event: an expired draft still
counts against `countLiveDraftsByCreatorApiToken` until its row is gone. Who
calls the sweep, and how often, is the hosting app's business — see
`apps/server/src/expiry-sweep.ts`.

Both drivers answer to those functions, and the contract suite is what holds them
to the same answers; the Postgres driver restates the visit rule as one SQL
predicate rather than reading the row first.

The clock is `DbDriverOptions.clock` — epoch milliseconds, `Date.now` by default,
the same shape `createApp` and the rate limiters take. **A test that winds time
forward must give the app and its database the same clock function.** Passing one
only to `createApp` moves the rate limiters and leaves retention on wall time,
which looks like the clock working and proves nothing.

## Schema migrations

One ordered list in `src/migrations.ts` — `SCHEMA_MIGRATIONS` — is the draft
half of the schema for both drivers; `accounts`, `api_tokens` and `token_mints`
are `@patchy/auth`'s migrations 1 and 2, so the list starts at 3. Each entry has
an ID and an optional step per driver, as `0005_drafts_expiry_columns` does for
the retention clock's anchor:

```ts
{
  id: "0005_drafts_expiry_columns",
  postgres: `ALTER TABLE drafts ADD COLUMN expires_at TIMESTAMPTZ; /* … */`,
  json(state) {
    /* default-fill `expiresAt` on every stored draft row */
  }
}
```

Read that one before writing a new column migration: it is the shipped worked
example of an additive column with a backfill, and its Postgres step shows the
whole additive sequence — add the column, backfill every existing row, only then
constrain it.

The JSON driver's `initialize()` seeds the bootstrap token when one is
configured; on Postgres the `@patchy/auth` tokens layer seeds it from
`PATCHY_BOOTSTRAP_API_TOKEN`. Seeding is not a migration: it re-runs on every
startup and must stay idempotent. `Tokens` in `@patchy/auth` names the two fixed
IDs it seeds — a fixed ID is a contract with a deployed database, so it is
spelled once.

**`0004_drafts_account_id_index`, `0005_drafts_expiry_columns`,
`0006_drafts_pinned_at`, and `0007_self_service_mint_records` are the shipped
additive migrations** — each ships permanently and none supersedes another;
`0004` exists because ownership lookups scan `drafts` by account, `0006` adds
the pin plus the partial index the sweep scans, and `0007` adds the JSON
driver's mint records (on Postgres they are `@patchy/auth`'s `token_mints`).
The **probe migrations
in `src/migration-fixtures.fixture.ts` are test-only** and never ship: they
exercise a column-level additive step on the JSON driver without putting a
placeholder column in the shipped schema.

### Postgres

The Postgres steps run through Effect's Migrator in `@patchy/sql`, behind the
`migrateDatabase` seam in `src/migrate.ts`, which composes them with
`@patchy/auth`'s record (`packages/sql/CONTEXT.md` has the contract). The Migrator's `schema_migrations` ledger is the guard, so a step is
plain DDL — no `IF NOT EXISTS` — and every pending step runs in one transaction
under an `ACCESS EXCLUSIVE` lock: a failing step rolls the whole batch back. The
server, the dev runner and the vitest template database all migrate through the
seam before the driver is opened (`openPatchyDb` in `src/factory.ts` does both).

### JSON: the default-fill convention

The JSON driver keeps its own ledger, the `schemaMigrations` array in the state
file, and runs the `json` steps itself on read. Its row guards describe the
**current** schema only — they are deliberately strict, and they reject a row
shape they don't know. Migrations are what make an older state readable: they
run against the parsed state _before_ the guards, so a migration's job is to
default-fill the fields its guard will then require. A field that later tickets
treat as nullable is filled with `null`; a field with a Postgres `DEFAULT` is
filled with that same default.

The reverse direction needs no work: guards ignore fields they don't know, so a
handle on an older schema still reads rows a newer one wrote.

Migrations apply on read and persist on the next write, so a read-only process
never rewrites the file.

## How to add a migration

1. **Append** an entry to `SCHEMA_MIGRATIONS` in `src/migrations.ts`. Never edit
   or reorder a merged entry — the ledger has already recorded it as applied,
   so an edit silently never runs. Fix a shipped migration with a new one.
2. **ID it** `NNNN_snake_case_summary` with the next zero-padded number. ID
   order is apply order.
3. **Write the Postgres step** as plain DDL: `ADD COLUMN`, `CREATE TABLE`,
   `CREATE INDEX` — the ledger guarantees it runs once. Additive only —
   dropping or retyping a column is a different conversation. Omit the step
   entirely if the migration doesn't touch Postgres.
4. **Write the JSON step** to default-fill the same fields on existing rows,
   reading defensively (the state is parsed, not yet guarded). Omit it when the
   change has no JSON analogue, such as an index.
5. **Extend the guards** in `src/json-db.ts` (`isDraftRecord` and friends) and
   the row interfaces to require the new fields, plus the record types in
   `src/types.ts` and the Postgres row mappers in `src/postgres-db.ts`.
6. **Test it through the contract suite.** Add the behavior your columns enable
   to `src/upload-contract.test.ts`, which runs every assertion against both
   JSON and an isolated embedded Postgres database. Assert through the port only —
   never by reading the state file or selecting the column directly. The
   mechanism itself is already covered — the JSON ledger cases in
   `upload-contract.test.ts` and the Migrator cases in `packages/sql` — so you
   do not need to re-prove any of it.
7. **Run both drivers** before opening the PR:

   ```sh
   pnpm --filter @patchy/db test
   ```

Both drivers migrate on startup: Postgres through the seam before the server
listens, JSON when the state file is first read.
