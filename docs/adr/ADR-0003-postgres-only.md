# ADR-0003 — Postgres only

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Hosting (`apps/server`), Companies (`packages/companies`), Auth (`packages/auth`), Patches (`packages/patches`), SQL (`packages/sql`) — the decision is about the one store every capability writes to, so it lives in the root ADR home.
- **Source**: Effect v4 port spec (#68) §2 and §3; build tickets #72 (`sql`), #74 (`auth`) and #76 (`patches`); [auth spec §3 and §11](https://github.com/allisonmahmood/patchy-cloud/issues/135) for the three baselines and shared seed.

## Context

Supporting both Postgres metadata and a local JSON driver required every query
rule and migration to be maintained twice. Local development and tests can
instead run embedded Postgres, so a second storage model buys no capability the
project needs.

The baseline rewrite was chosen before production deployment; it is not a
recipe for discarding a deployed database's migration history.

## Decision

Postgres is the only store. The JSON driver, the `PatchyDb` port and its
contract suite are deleted; capability packages query `@effect/sql-pg` through
`SqlSchema` directly, and every rule exists once, in SQL.

1. **One baseline per owner.** The pre-deployment history was rewritten
   rather than carried forward: Companies owns baseline 1
   (`companies`, `users`, `invites`), Auth owns 2 (`machine_tokens`,
   `device_logins`), and Patches owns 3 (`patches`, `patch_versions`).
   Every enumerated column is text with a check constraint, not a Postgres enum.
2. **Embedded Postgres is the dev and test store.** `pnpm dev` migrates and
   seeds one per worktree; `@patchy/sql/testing` gives every `it.layer` block a
   clone of the same seeded template, with an empty layer for migrator tests.

## Consequences

**Every retention rule has one home.** The not-expired predicate and the visit
top-up are SQL fragments in `Patches.ts`; there is
no TypeScript twin and no suite to keep the two honest. The Effect clock reads
into the query as `to_timestamp(...)`, so a test still winds time.

**Running the server means having a Postgres.** `DATABASE_URL` is required;
the runner is the path that provides one locally. A local metadata file is not
an alternative server mode.

**A future migration has one database target.** Schema changes and any required
data backfill are Postgres steps, with no JSON transform to maintain beside them.

## Alternatives considered

- **Keep the JSON driver for local runs.** Rejected: the runner already
  provides Postgres, and the driver's cost was every rule twice plus a 1,300-line
  contract suite.
- **Carry the migration history forward.** Rejected: nothing is deployed to
  migrate, and a baseline written for the new names is what an agent reading
  the schema should find.
