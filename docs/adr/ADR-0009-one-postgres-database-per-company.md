# ADR-0009 — One Postgres database per company

Company resources live in one Postgres database per company, separate from the platform database. This gives a company an explicit dump/restore boundary without making every patch a database. Compute, storage, connection limits and server-wide backups remain shared: this is not per-company resource isolation or independent point-in-time recovery.

## Placement and creation

The platform `company_databases` row is the authority: company id, server id, database name, placement version, status and creation/readiness timestamps. A first operation needing resources claims it idempotently; company signup and primitive-free publishing create nothing. One server exists today, `primary`. A claim moves to `ready` only after creation, ownership, grants, settings and inventory initialization succeed. An interrupted operation resumes the same claim, including when `CREATE DATABASE` succeeded before the process stopped.

Creation runs outside any transaction through `PATCHY_COMPANY_DB_ADMIN_URL`, a maintenance-database login with `CREATEDB`. The provisioning login must be able to assign ownership to the data role. `template1` is the creation template; settings and permissions are applied afterwards. `PATCHY_COMPANY_DB_URL` supplies the data role and server connection options; the placement replaces its database name. Both URLs are required at server startup. Do not give the ordinary data login cluster administration privileges; the embedded development superuser is a disposable-local exception.

The new platform migration is `0005_company_database_baseline`: issue #196 reserved 0004 before `0004_invites_expiry` occupied it. Preserving that existing ledger entry takes precedence over reusing its number.

## Pools and locks

Use direct connections and a scoped `RcMap` registry: at most 100 retained company pools, idle TTL 60 seconds, pool maximum 4 and minimum 0. Leases last one operation. Admission exhaustion returns `busy` rather than waiting. `PATCHY_COMPANY_DB_MAX_BACKENDS` defaults to 200 and budgets retained pool maxima, not only currently executing queries. Operators must sum budgets across replicas and leave separate platform/provisioning/administration headroom below the server's available user connections.

PgBouncer is deferred: the pinned Effect PostgreSQL adapter cancels via `pg_cancel_backend(client.processID)`, which is not a valid backend identity through its transaction pooler. Transaction advisory locks should remain on the same reserved transaction connection under transaction pooling, but that source-level inference is not a tested pooler guarantee. Schemas are qualified explicitly; no session `SET search_path`.

Callers always take the platform patch-row lock first. Only existing inventory or an operation introducing resources opens a company transaction under `withPatchLock`. The lock uses a stable patch key with `pg_advisory_xact_lock`, and covers re-reading the inventory, DDL, inventory writes and the revision. Company commit precedes platform commit; no distributed transaction is promised. Ordinary `CREATE INDEX` blocks writers for its duration; `CONCURRENTLY` cannot join this transaction and is not used.

## Inventory and reclamation

The company database's `patchy` schema holds the cumulative provisioning authority: patches and their schema revisions, tables, columns, indexes, stores, and the file index. Physical namespaces are `p_<patchId>`; table and column identifiers are quoted as written. Inventory commits with DDL and is never rolled back merely because the active patch version is rolled back. Table-change callers advance the revision; a new patch version alone does not.

The existing startup/hourly sweep reclaims namespaces with no platform patch row after a day, and immutable `files/<patchId>/<store>/<objectId>` objects unnamed by any file index after a day. Namespace age is recorded with inventory; previously untracked schemas are first observed and given a full grace period. An unavailable company database is not evidence that a file is unreferenced. Version cleanup never owns file objects.

The background orphan sweep scans file references in batches. On `busy`, it
releases its lease and waits past the idle TTL before one retry; persistent
exhaustion leaves that work for a later run. Large sweeps can therefore span
several TTL pauses without changing fail-fast foreground admission.

## Local execution and moving companies

`pnpm dev` and concurrency tests use embedded Postgres with the same provisioning path. Test blocks create company databases lazily and drop them after their pools close. The patch-development adapter uses the same inventory SQL over `PgliteClient`, one directory and connection, fsync off, with `int8` and `DATE` codecs normalized. Each unsafe call contains one statement. PGlite directories are recreatable local state; this layer imports no production bootstrap and cannot prove multi-session locking behavior.

Moving a company remains a deliberate downtime cutover: pause operations across replicas, drain pools, dump/restore, switch placement with a version bump, invalidate old pools and resume. This implementation records placement versions but does not provide a move command or an online migration protocol.

Sources: [SDK spec §3](https://github.com/allisonmahmood/patchy-cloud/issues/193), [database decision](https://github.com/allisonmahmood/patchy-cloud/issues/168#issuecomment-5560480679), [pooling research](https://github.com/allisonmahmood/patchy-cloud/issues/178#issuecomment-5560583343), [PGlite research](https://github.com/allisonmahmood/patchy-cloud/issues/177#issuecomment-5560575625).
