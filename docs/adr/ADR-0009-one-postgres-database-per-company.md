# ADR-0009 — One Postgres database per company

Company resources live in one Postgres database per company, separate from the platform database. This gives a company an explicit dump/restore boundary without making every patch a database. Compute, storage, connection limits and server-wide backups remain shared: this is not per-company resource isolation or independent point-in-time recovery.

## Placement and creation

The platform `company_databases` row is the authority: company id, server id, database name, placement version, status and creation/readiness timestamps. A first operation needing resources claims it idempotently; company signup and primitive-free publishing create nothing. One server exists today, `primary`. A claim moves to `ready` only after creation, ownership, grants, settings and inventory initialization succeed. An interrupted operation resumes the same claim, including when `CREATE DATABASE` succeeded before the process stopped.

Provisioning is explicit: callers use `claim`/`ensureReady` only when introducing resources. `withCompany` leases an already-ready placement; an absent or claimed placement returns `CompanyDatabaseNotReady` without inserting a claim or creating a database.

Creation runs outside any transaction through `PATCHY_COMPANY_DB_ADMIN_URL`, a maintenance-database login with `CREATEDB` and permission to `SET ROLE` to the data role. `CREATE DATABASE ... OWNER` establishes ownership immediately from `template1`; the data owner then applies settings, permissions and inventory initialization. The provisioning login needs no inherited data access. `PATCHY_COMPANY_DB_URL` supplies the data role and server connection options; the placement replaces its database name. Both URLs are validated as redacted PostgreSQL URLs at startup, with an explicit login; the last `user` query value overrides the authority when nonempty, matching `pg`. Do not give the ordinary data login cluster administration privileges; the embedded development superuser is a disposable-local exception.

The `CREATE DATABASE` statement is autocommit on the provisioning connection, never inside a PostgreSQL transaction block. A separate placement transaction holds the claim-row lock through creation and initialization to serialize replicas and make interrupted creation resumable; this does not make the admin statement transactional.

The new platform migration is `0005_company_database_baseline`: issue #196 reserved 0004 before `0004_invites_expiry` occupied it. Preserving that existing ledger entry takes precedence over reusing its number.

## Pools and locks

Use direct connections and a scoped `RcMap` registry: at most 100 retained company pools, idle TTL 60 seconds, pool maximum 4 and minimum 0. Leases last one operation. Admission exhaustion returns `busy` rather than waiting. `PATCHY_COMPANY_DB_MAX_BACKENDS` defaults to 200 and budgets retained pool maxima, not only currently executing queries. Operators must sum budgets across replicas and leave separate platform/provisioning/administration headroom below the server's available user connections.

Placement queries use a separate pool of at most two connections with the platform credentials. They never borrow from the ordinary platform pool: callers may already hold every platform connection in patch-row transactions. This both avoids circular pool acquisition and keeps claims committed independently of caller rollback. Budget these two connections, the one admin connection, and temporary provisioning data connections separately from retained company pools.

PgBouncer is deferred: the pinned Effect PostgreSQL adapter cancels via `pg_cancel_backend(client.processID)`, which is not a valid backend identity through its transaction pooler. Transaction advisory locks should remain on the same reserved transaction connection under transaction pooling, but that source-level inference is not a tested pooler guarantee. Schemas are qualified explicitly; no session `SET search_path`.

Provisioning and reclamation callers take the platform patch-row lock first. Only existing inventory or an operation introducing resources opens a company transaction under `withPatchLock`. The lock uses a stable patch key with `pg_advisory_xact_lock`, and covers re-reading the inventory, DDL, definition-inventory writes and the revision. Company commit precedes platform commit; no distributed transaction is promised. Ordinary `CREATE INDEX` blocks writers for its duration; `CONCURRENTLY` cannot join this transaction and is not used.

`withCompany` supplies a typed company-connection capability. `withPatchLock` requires that capability and supplies a patch-lock capability tied to its patch id and transaction. Definition-inventory mutations require the latter and reject a mismatched patch id before writing; they do not quietly start independent transactions. Raw SQL for resource DDL follows the same outer lock protocol.

Runtime file operations are company-only: `LoadedVersions` admission supplies patch liveness and viewer authority, never a second platform lookup inside `Files`. `withFileLock` requires a company lease and serializes the index entry for one patch/store/name using a distinct advisory key. Its file-lock capability carries that identity; index writes reject a mismatched patch, store or name. Put writes a unique immutable object before acquiring the lease and index lock; get reads its pointer under the lock and releases the lease before fetching bytes. Delete changes only the index, and list uses a lease without a write lock. Blob I/O therefore holds neither platform nor company transactions, and unrelated names do not share a file lock. Failed or interrupted puts may leave unnamed objects for the existing grace-period sweep.

## Inventory and reclamation

The company database's `patchy` schema holds the cumulative provisioning authority: patches and their schema revisions, tables, columns, indexes, stores, and the file index. Physical namespaces are `p_<patchId>`; table and column identifiers are quoted as written. Inventory commits with DDL and is never rolled back merely because the active patch version is rolled back. Table-definition changes and new stores advance the revision; a new patch version or a file-content mutation alone does not.

Inventory reads acquire the same patch lock as provisioning, so their revision
and component queries cannot straddle a writer's commit. These metadata reads
may wait for provisioning; they do not return a partly old, partly new inventory.

The existing startup/hourly sweep reclaims namespaces with no platform patch row after a day, and immutable `files/<patchId>/<store>/<objectId>` objects unnamed by any file index after a day. Namespace age is recorded with inventory; previously untracked schemas are first observed and given a full grace period. An unavailable company database is not evidence that a file is unreferenced. Version cleanup never owns file objects.

Before deleting an unreferenced file belonging to an existing patch, the sweep locks its platform row, takes the owning company patch lock, and rechecks the file index. Both locks remain held through deletion. Absent patch rows cannot be gap-locked; their cleanup relies on immutable object keys, never-reused patch ids, and the one-day grace exceeding publication's deadline.

Expiry and orphan passes run in independent scoped fibers. Each contains non-interruption failures per pass and retries at its next hourly tick; shutdown interruption still terminates both. A blocked or defective orphan pass cannot stop expiry.

The background orphan sweep scans file references in batches. On `busy`, it
releases its lease and waits past the idle TTL before one retry; persistent
exhaustion leaves that work for a later run. Large sweeps can therefore span
several TTL pauses without changing fail-fast foreground admission.

## Local execution and moving companies

`pnpm dev` and concurrency tests use embedded Postgres with the same provisioning path. Test blocks create company databases lazily and drop them after their pools close. The patch-development adapter uses the same inventory SQL over `PgliteClient`, one directory and connection, fsync off, with `int8` and `DATE` codecs normalized. Each unsafe call contains one statement. PGlite directories are recreatable local state; this layer imports no production bootstrap and cannot prove multi-session locking behavior.

Moving a company remains a deliberate downtime cutover: pause operations across replicas, drain pools, dump/restore, switch placement with a version bump, invalidate old pools and resume. This implementation records placement versions but does not provide a move command or an online migration protocol.

Sources: [SDK spec §3](https://github.com/allisonmahmood/patchy-cloud/issues/193), [database decision](https://github.com/allisonmahmood/patchy-cloud/issues/168#issuecomment-5560480679), [pooling research](https://github.com/allisonmahmood/patchy-cloud/issues/178#issuecomment-5560583343), [PGlite research](https://github.com/allisonmahmood/patchy-cloud/issues/177#issuecomment-5560575625).
