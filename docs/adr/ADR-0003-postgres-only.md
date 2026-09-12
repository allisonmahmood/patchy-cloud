# ADR-0003 — Postgres only

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Hosting (`apps/server`), SQL (`packages/sql`) and the capabilities that persist platform metadata or company resources. This is the shared relational storage decision, not a replacement for the content store that holds bytes.
- **Source**: Effect v4 port spec (#68) §2 and §3; build tickets #72 (`sql`), #74 (`auth`) and #76 (`patches`); [auth spec §3 and §11](https://github.com/allisonmahmood/patchy-cloud/issues/135); [SDK map decisions](https://github.com/allisonmahmood/patchy-cloud/issues/164) and [SDK spec §14](https://github.com/allisonmahmood/patchy-cloud/issues/193).

## Context

Supporting both Postgres metadata and a local JSON driver required every query
rule and migration to be maintained twice. Local development and tests can
instead run embedded Postgres, so a second storage model buys no capability the
project needs.

The baseline rewrite was chosen before production deployment; it is not a
recipe for discarding a deployed database's migration history.

## Decision

Postgres is the platform store. The JSON driver, the `PatchyDb` port and its
contract suite are deleted; capability packages query a `SqlClient` through
`SqlSchema`. Company resources live in a separate Postgres database per company,
not a second storage model. [ADR-0009](./ADR-0009-one-postgres-database-per-company.md)
owns placement, pooling and the inventory; patch development runs the same
capability services over PGlite.

1. **Migrations belong to capabilities, with one platform ledger.** The original
   baselines were rewritten before deployment. The current ledger has seven
   records across six owners:

   | id   | owner            | record                      |
   | ---- | ---------------- | --------------------------- |
   | 0001 | Companies        | `companies_baseline`        |
   | 0002 | Auth             | `auth_baseline`             |
   | 0003 | Patches          | `patches_baseline`          |
   | 0004 | Companies        | `invites_expiry`            |
   | 0005 | Company database | `company_database_baseline` |
   | 0006 | Runtime          | `runtime_baseline`          |
   | 0007 | Integrations     | `integrations_baseline`     |

   The patches baseline includes names, manifests, version stamps and publish
   recovery; `connection_snapshots` belongs to the integrations baseline.
   Enumerated platform columns use text with check constraints, not Postgres enums.

2. **Embedded Postgres is the cloud worktree and test store.** `pnpm dev`
   migrates and seeds one per worktree. `@patchy/sql/testing` gives each
   `it.layer` block a clone of the seeded platform template, with an empty layer
   for migrator tests; company databases are created lazily through the same
   provisioning path and dropped after their pools close.
3. **PGlite is local Postgres, not a substitute persistence model.** `patchy dev`
   runs the real company-database and capability code against local PGlite and a
   filesystem content store. Connections and shared tables bind to authored
   fixtures; only metadata, never production rows, bytes or credentials, comes
   from the instance. PGlite serializes its one connection, so it cannot prove
   lost updates, lock waits, deadlocks or publish-versus-writer races. The
   real-Postgres concurrency CI is mandatory; see [Development](../DEVELOPMENT.md).

## Consequences

**Every retention rule has one home.** The not-expired predicate and the visit
top-up are SQL fragments in `Patches.ts`; there is
no TypeScript twin and no suite to keep the two honest. The Effect clock reads
into the query as `to_timestamp(...)`, so a test still winds time.

**Running the server means having a Postgres.** `DATABASE_URL` is required;
the runner is the path that provides one locally. A local metadata file is not
an alternative server mode.

**Migrations target their owning database.** Platform metadata migrations run
through the platform ledger. Company inventory initialization runs in each
company database; both drivers execute its same PostgreSQL statements.
The PGlite path emits one statement per `sql.unsafe` call and normalizes `int8`
and `DATE` codecs to match the PostgreSQL driver. Its fsync-off directories are
recreatable local state, not a backup or a production database.

The pre-deployment name backfill requested by #195 is a seed operation, not an
upgrade of an existing schema: the rewritten baseline already contains the name
columns and namespace. The shared `Patches.backfillNames` seed runs transactionally
against Postgres and reuses publishing's Unicode normalization and suffix rules;
the dev runner and test template call the same implementation. This exception
does not replace Migrator steps for deployed schema changes or their data backfills.

## Alternatives considered

- **Keep the JSON driver for local runs.** Rejected: the runner already
  provides Postgres, and the driver's cost was every rule twice plus a 1,300-line
  contract suite.
- **Carry the migration history forward.** Rejected: nothing is deployed to
  migrate, and a baseline written for the new names is what an agent reading
  the schema should find.
