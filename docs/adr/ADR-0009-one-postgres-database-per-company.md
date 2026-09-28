# ADR-0009 — One Postgres database per company

Company resources live in one Postgres database per company, separate from the platform database. This gives a company an explicit dump/restore boundary without making every patch a database. Compute, storage, connection limits and server-wide backups remain shared: this is not per-company resource isolation or independent point-in-time recovery.

## Placement and creation

The platform `company_databases` row is the authority: company id, server id, database name, placement version, status and creation/readiness timestamps. A first operation needing resources claims it idempotently; company signup and primitive-free publishing create nothing. One server exists today, `primary`. A claim moves to `ready` only after creation, ownership, grants, settings and inventory initialization succeed. An interrupted operation resumes the same claim, including when `CREATE DATABASE` succeeded before the process stopped.

Provisioning is explicit: callers use `claim`/`ensureReady` only when introducing resources. `withCompany` leases an already-ready placement; an absent or claimed placement returns `CompanyDatabaseNotReady` without inserting a claim or creating a database.

Creation runs outside any transaction through `PATCHY_COMPANY_DB_ADMIN_URL`, a maintenance-database login with `CREATEDB` and permission to `SET ROLE` to the data role. `CREATE DATABASE ... OWNER ... TEMPLATE template0` establishes ownership of a pristine database; the data owner then applies settings, permissions and inventory initialization. `template1` is not used: the Neon spike project's TimescaleDB scheduler held a source session while waiting on the placement transaction, causing creation to fail with `55006`. Company inventory needs none of that template's extensions. The provisioning login needs no inherited data access. `PATCHY_COMPANY_DB_URL` supplies the data role and server connection options; the placement replaces its database name. Both URLs are validated as redacted PostgreSQL URLs at startup, with an explicit login; the last `user` query value overrides the authority when nonempty, matching the client. Do not give the ordinary data login cluster administration privileges; the embedded development superuser is a disposable-local exception.

The `CREATE DATABASE` statement is autocommit on the provisioning connection, never inside a PostgreSQL transaction block. A separate placement transaction holds the claim-row lock through creation and initialization to serialize replicas and make interrupted creation resumable; this does not make the admin statement transactional.

Roles are operator-provisioned, not created per placement. On Neon, after creating
the data role, grant `GRANT company_x TO patchy_admin WITH SET TRUE, INHERIT FALSE`.
Alternatively configure the creating admin's `createrole_self_grant = 'set'`.
Whole-database reclamation must reserve one maintenance connection, `SET ROLE
company_x`, issue `DROP DATABASE` outside a transaction, then `RESET ROLE` before
returning the connection. A `CREATEDB` admin without inherited ownership cannot
drop the data role's database merely because it created it.

The platform migration is `0005_company_database_baseline`; Companies retains
`0004_invites_expiry`. Runtime follows at 0006, Integrations at 0007, and the
Patches lifecycle at 0008. [ADR-0003](./ADR-0003-postgres-only.md) records the
eight-entry platform ledger.

## Pools and locks

Use direct connections and a scoped `RcMap` registry: at most 100 retained company pools, idle TTL 60 seconds, and minimum 0 connections. `company.connections` defaults to 4 per company per host replica, with per-company operating overrides. Leases last one operation. When those slots are occupied, both tiers wait behind at most 32 queued acquisitions (`company.connections.waiters`) for at most 1 second (`company.connections.wait`), still inside the caller's deadline. Queue overflow or expiry returns `busy` with `retryAfter`, scope, limit id and value. Request events record the queue wait. Interrupted waiters release their queue slot.

Pool overrides change only the named company. Existing leases drain before a
replacement pool opens, so old and new maxima do not overlap.
`PATCHY_COMPANY_DB_MAX_BACKENDS` defaults to 200 and budgets retained pool maxima,
not only currently executing queries. Operators must sum budgets across replicas
and leave separate platform/provisioning/administration headroom below the server's
available user connections. Admission counts are per host replica in v1.

The company's token bucket belongs to Runtime, not Company database. It admits
100 calls per second with a burst of 200, including operations that never lease a
connection. It counts each tier 1 operation or tier 2 call once, not callbacks or
subscription re-runs, and refuses with `limit_exceeded`.

Placement queries use a separate pool of at most two connections with the platform credentials. They never borrow from the ordinary platform pool: callers may already hold every platform connection in patch-row transactions. This both avoids circular pool acquisition and keeps claims committed independently of caller rollback. Budget these two connections, the one admin connection, and temporary provisioning data connections separately from retained company pools.

The pinned native Effect PostgreSQL driver sends protocol `CancelRequest`s, including through Neon's TLS proxy. Do not use `pg_cancel_backend` with the proxy's synthetic BackendKeyData pid. Retained connections are disposable: fatal socket or idle-client errors invalidate the pool entry and later work acquires a new connection. This does not replay interrupted work or establish an uncertain commit's outcome. Production Neon compute must have suspend disabled.

PgBouncer remains deferred. Named prepared statements and session behavior need
separate pooler validation; protocol cancellation support alone is not that proof.
Schemas are qualified explicitly; no session `SET search_path`.

Provisioning and reclamation callers take the platform patch-row lock first. Only existing inventory or an operation introducing resources opens a company transaction under `withPatchLock`. The lock uses a stable patch key with `pg_advisory_xact_lock`, and covers re-reading the inventory, DDL, definition-inventory writes and the revision. Company commit precedes platform commit; no distributed transaction is promised. Ordinary `CREATE INDEX` blocks writers for its duration; `CONCURRENTLY` cannot join this transaction and is not used.

Publish commits, retire, delete and restore first take a company-keyed transaction advisory lock in the platform database. This serializes dependency admissions with source lifecycle and unshare checks: a new or restored consumer cannot commit behind a check that saw no live dependant. The order is dependency lock, platform patch row, then company patch lock. Publishes within a company serialize through commit; uploads and ordinary reads do not hold this dependency lock.

`withCompany` supplies a typed company-connection capability. `withPatchLock` requires that capability and supplies a patch-lock capability tied to its patch id and transaction. Definition-inventory mutations require the latter and reject a mismatched patch id before writing; they do not quietly start independent transactions. Raw SQL for resource DDL follows the same outer lock protocol.

Runtime file operations are company-only: `LoadedVersions` admission supplies patch liveness and viewer authority, never a second platform lookup inside `Files`. `withFileLock` requires a company lease and serializes the index entry for one patch/store/name using a distinct advisory key. Its file-lock capability carries that identity; index writes reject a mismatched patch, store or name. Put writes a unique immutable object before acquiring the lease and index lock; get reads its pointer under the lock and releases the lease before fetching bytes. Delete changes only the index, and list uses a lease without a write lock. Blob I/O therefore holds neither platform nor company transactions, and unrelated names do not share a file lock. Failed or interrupted puts may leave unnamed objects for the existing grace-period sweep.

Shared-table reads resolve source liveness through `LoadedVersions` before
leasing the company database; they never query or lock platform rows inside
the primitive operation. The source inventory supplies the live sharing flag
and cumulative definition under its company patch lock. The reader then uses
the same indexed row operations as owned tables. A declaration's source patch
id and table are stable; active-version changes never replace that identity
or sharing authority.

## Inventory and reclamation

The company database's `patchy` schema holds the cumulative provisioning authority: patches and their schema revisions, tables, columns, indexes, stores, and the file index. Tables and stores have required descriptions. Publishing a definition replaces its description; omission preserves it. Physical namespaces are `p_<patchId>`; table and column identifiers are quoted as written. Inventory commits with DDL and is never rolled back merely because the active patch version is rolled back. Table-schema and sharing changes and new stores advance the revision; description changes, a new patch version or a file-content mutation alone do not.

Inventory reads acquire the same patch lock as provisioning, so their revision
and component queries cannot straddle a writer's commit. These metadata reads
may wait for provisioning; they do not return a partly old, partly new inventory.

`Inventory.initialize` runs the shared idempotent `Inventory.upgrade` steps after
creating missing tables. `ensureReady` also upgrades already-ready placements.
Changes to existing structures belong in those upgrades, such as `ADD COLUMN IF
NOT EXISTS`, not only in fresh-database DDL. The portable inventory contract runs
initialization twice against an already-initialized database with a missing column,
on PostgreSQL and PGlite, and checks that existing rows and definitions survive.
A versioned per-company migration ledger remains deferred.

The deletion sweep reclaims deleted patches after their 30-day recovery window.
It locks the platform row, rechecks the delete deadline and takes the company
patch lock when inventory exists. It durably queues version object keys and
deletes versions, names and the patch row in one platform transaction, then
reclaims the company namespace and its files. Restore takes the same row lock.
A crash after platform commit leaves an orphan namespace for the existing sweep;
retire and delete inside the recovery window change no physical resources.

The existing startup/hourly sweep reclaims namespaces with no platform patch row after a day, and immutable `files/<patchId>/<store>/<objectId>` objects unnamed by any file index after a day. Namespace age is recorded with inventory; previously untracked schemas are first observed and given a full grace period. An unavailable company database is not evidence that a file is unreferenced. Version cleanup never owns file objects.

Before deleting an unreferenced file belonging to an existing patch, the sweep locks its platform row, takes the owning company patch lock, and rechecks the file index. Both locks remain held through deletion. Absent patch rows cannot be gap-locked; their cleanup relies on immutable object keys, never-reused patch ids, and the one-day grace exceeding publication's deadline.

Deletion and orphan passes run in independent scoped fibers. Each contains non-interruption failures per pass and retries at its next hourly tick; shutdown interruption still terminates both. A blocked or defective orphan pass cannot stop deletion.

The background orphan sweep scans file references in batches. On `busy`, it
releases its lease and waits past the idle TTL before one retry; persistent
exhaustion leaves that work for a later run. Large sweeps can therefore span
several TTL pauses without changing the bounded foreground connection wait.

## Local execution and moving companies

`pnpm dev` and concurrency tests use embedded Postgres with the same provisioning path. Test blocks create company databases lazily and drop them after their pools close. The patch-development adapter uses the same inventory SQL over `PgliteClient`, one directory and connection, fsync off, with `int8` and `DATE` codecs normalized. Each unsafe call contains one statement. PGlite directories are recreatable local state; this layer imports no production bootstrap and cannot prove multi-session locking behavior.

Moving a company remains a deliberate downtime cutover: pause operations across replicas, drain pools, dump/restore, switch placement with a version bump, invalidate old pools and resume. This implementation records placement versions but does not provide a move command or an online migration protocol.

Sources: [SDK spec §3](https://github.com/allisonmahmood/patchy-cloud/issues/193), [database decision](https://github.com/allisonmahmood/patchy-cloud/issues/168#issuecomment-5560480679), [pooling research](https://github.com/allisonmahmood/patchy-cloud/issues/178#issuecomment-5560583343), [PGlite research](https://github.com/allisonmahmood/patchy-cloud/issues/177#issuecomment-5560575625).
