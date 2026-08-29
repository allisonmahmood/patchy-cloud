# ADR-0003 — Postgres only

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Hosting (`apps/server`), Auth (`packages/auth`), Patches (`packages/patches`), SQL (`packages/sql`) — the decision is about the one store every capability writes to, so it lives in the root ADR home.
- **Source**: Effect v4 port spec (#68) §2 and §3; build tickets #72 (`sql`), #74 (`auth`) and #76 (`patches`).

## Context

PatchPage shipped two metadata drivers behind one `PatchyDb` port: Postgres for
a deployed instance and a single JSON file for anyone running it on a laptop.
Both were held to one contract suite, every migration had a step per driver,
and every query rule — the retention clock, the visit top-up, the pin — was
written twice, once in SQL and once in TypeScript, with the suite asserting the
two agreed.

After the port Patchy Cloud is the only deployment, and no
production database exists yet. The dev runner (#81) already starts an embedded
Postgres per worktree, and the vitest template database is one too.

## Decision

Postgres is the only store. The JSON driver, the `PatchyDb` port and its
contract suite are deleted; capability packages query `@effect/sql-pg` through
`SqlSchema` directly, and every rule exists once, in SQL.

1. **One baseline per owner.** Because nothing is deployed, the migration
   history is rewritten rather than carried: `auth` owns ids 1–2
   (`accounts`, `api_tokens`, `token_mints`), `patches` owns 3 onward
   (`patches`, `patch_versions`). Additive steps that only ever existed to move
   the JSON file along — `visibility`, `upload_events`, the expiry-column
   backfill — are gone with it.
2. **The rename lands in the tables.** `drafts` and `draft_versions` become
   `patches` and `patch_versions`; the wire had already renamed (ADR-0002).
3. **Embedded Postgres is the dev and test store.** `pnpm dev` migrates and
   seeds one per worktree; `@patchy/sql/testing` gives an `it.layer` block a
   fresh migrated database, and the server's tests clone a migrated template.

## Consequences

**Every retention rule has one home.** The not-expired predicate, the visit
top-up and the revocation freeze are SQL fragments in `Patches.ts`; there is
no TypeScript twin and no suite to keep the two honest. The Effect clock reads
into the query as `to_timestamp(...)`, so a test still winds time.

**Running the server means having a Postgres.** `DATABASE_URL` is required;
the runner is the path that provides one. The Docker image lost its file-store
mode, and the guide to running an instance of your own went with #79: Patchy
Cloud is the only deployment.

**A future migration is one DDL step.** No JSON transform, no default-fill for
rows written by an older shape.

## Alternatives considered

- **Keep the JSON driver for local runs.** Rejected: the runner already
  provides Postgres, and the driver's cost was every rule twice plus a 1,300-line
  contract suite.
- **Carry the migration history forward.** Rejected: nothing is deployed to
  migrate, and a baseline written for the new names is what an agent reading
  the schema should find.
