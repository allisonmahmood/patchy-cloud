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

The baseline rewrite was chosen before production deployment, and so was the
later squash to one baseline per capability; neither is a recipe for discarding
a deployed database's migration history.

## Decision

Postgres is the platform store. The JSON driver, the `PatchyDb` port and its
contract suite are deleted; capability packages query a `SqlClient` through
`SqlSchema`. Company resources live in a separate Postgres database per company,
not a second storage model. [ADR-0009](./ADR-0009-one-postgres-database-per-company.md)
owns placement, pooling and the inventory; patch development runs the same
capability services over PGlite.

Published patch bytes, immutable file objects and SDK archives remain outside
Postgres in the content store. Deployments use Neon Object Storage through its
S3-compatible API; development and offline tests use the filesystem. A bucket
belongs to the Neon branch selected by its endpoint, not to a global S3 namespace.

1. **Migrations belong to capabilities, with one platform ledger.** The original
   baselines were rewritten before deployment, and the record was squashed before
   launch into one baseline per capability, ids 1 to 8 in foreign-key order.
   Each capability keeps its records in its `src/migrations.ts`;
   `apps/server/src/migrations.ts` composes them into the one ledger that the
   server, the dev runner and the test template apply. Ids are allocated in
   landing order, and that record's test fails on a duplicate or skipped id.
   Migrating refuses a ledger whose steps differ from the record's up to the
   lower of their highest ids, such as a database from before the squash.

   The patches baseline includes names, manifests, version stamps and publish
   recovery; `connection_snapshots` belongs to the integrations baseline.
   The lifecycle revision advances with each publish, sharing change, retire,
   delete, restore and rollback. Soft deletion keeps the counter; reclamation
   removes the row, leaving permanent absence as the final deletion evidence.
   Enumerated platform columns use text with check constraints, not Postgres enums.
   Runtime invocation attribution keeps the initiating viewer separate from the
   effective principal. Every call row has an effective principal; patch
   callbacks have a null `user_id` and an `invocation_id`. Both operation and
   invocation rows accept `handler_error`.
   Invocation rows retain deadlines, settlement, log lines, reply delivery and
   metering fields including database-held milliseconds. Settlement can reconcile
   `unknown_outcome`, but cannot replace a final outcome.
   The runtime baseline also holds minute-keyed query rollups and applied-run ids.
   Rollup increments, deduplication transactions and pruning belong to metering.
   Mutation keys live in the company database, committed with the mutation's
   writes, result and originating invocation id. That link lets later replay
   reconcile an unresolved platform invocation without losing its metering.
   Company inventory initialization creates their store, with no platform
   migration id. Invocation rows record mutation commit proof separately from host
   settlement. A replay can establish success before the original finalizer
   writes its timing and metering, without fabricating those measurements or
   allowing a late unknown outcome to overwrite committed success.
   Companies' directory revision lives in a separate row per company. A user
   trigger advances it for joins, deletions, company moves and changes to the
   directory's profile, role or active state, but not for unchanged values.
   The separate row avoids reversing the company-before-user lock order used
   by admin actions when sign-in refreshes a user's profile.
   The trigger also sends the resource key on the shared platform NOTIFY
   transport. PostgreSQL delivers the change fact only after the outermost
   transaction commits, so a portal transaction can wrap a Companies service's
   savepoint without waking readers early. Rollback discards both the revision
   and notification. The existing host listener dispatches these keys locally
   and across replicas; Companies imports neither Runtime nor Primitives.

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

**The recovery window has one home.** `Patches.ts` derives `purgeAt` from the
delete stamp and a fixed 30-day window. Restore and reclamation compare it with
the Effect clock under the same platform row lock, so a patch cannot be restored
after reclamation or kept past its recovery window by visits.

**Running the server means having a Postgres.** `DATABASE_URL` is required;
the runner is the path that provides one locally. A local metadata file is not
an alternative server mode.

**Migrations target their owning database.** Platform metadata migrations run
through the platform ledger. Company inventory initialization runs in each
company database; both drivers execute its same PostgreSQL statements.
Both paths emit one statement per `sql.unsafe` call, and both read `int8` and
`DATE` as strings and timestamps as `Date` (the PGlite parsers mirror the
`@patchy/sql` row codecs). Its fsync-off directories are
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
