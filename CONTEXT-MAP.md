# Context Map

Patchy Cloud is one deployment: the hosting server on one side, the `patchy` CLI agents publish through on the other, and a wire contract between them. The contexts below are the product's, not the packages': each names the packages that implement it today. `docs/product.md` carries the product's shape and future decisions; the glossaries carry its words.

## Contexts

- [Patches](./packages/patches/CONTEXT.md): `packages/patches`. Patches and immutable versions, company-scoped names, manifests and replay-safe publish keys, tier 0, tier 1 and tier 2 bundle admission, additive table and store provisioning, company-readable inventory and the shared discovery query, ownership, sharing, retire, delete, restore, rollback, reassignment, descriptions, actor stamps, visits, the owner quota, the deletion sweep and the `patches` API group.
- [Serving](./packages/serving/CONTEXT.md): `packages/serving`. Patch addresses and version/content URLs, tier 0, tier 1 and tier 2 pages, the sandboxed frame and document-bound broker, route bridge, login and needs-rebuild doors, retired and deleted address notices, serving guarantees, admitted visits and trusted-proxy attribution. The connect door remains future work; Runtime owns the invocation's patch/viewer authority.
- [Companies](./packages/companies/CONTEXT.md): `packages/companies`. Companies and handles, users and roles, create-or-join, invitations, the company page, and deactivation/reactivation coordinated with patch choices in the portal. Groups, verified domains, SSO, billing, suspension and the operator's surfaces remain future work.
- [Portal](./packages/portal/CONTEXT.md): `packages/portal`. The signed-in index at `/`, patch cards, versions, inline description, sharing and rollback, lifecycle and reassignment confirmations, the per-patch log and the card's recent activity, stale-action refusals, and user deactivation/reactivation pick and confirmation pages. Browser sessions enter through Auth; pages compose the app shell over Patches and Companies.
- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`. Clerk session verification and viewers, user-owned machine tokens, device login, identity, revocation and bearer parsing, the sign-in and sign-out pages, Your machines, the `auth` API group and the shared dev seed
- [Runtime](./packages/runtime/CONTEXT.md): `packages/runtime` and `packages/execution`, sharing Runtime's glossary. Runtime owns browser and invocation admission, loaded versions, capabilities, private callbacks, host-owned transactions and mutation keys, invocation attribution and metering, revisions, subscriptions and document streams. Execution implements the credential-free loader engine, isolated bundle inspection, process supervisor, private management listener, local executor and ECS fleet provider through Runtime's ports. Production admission requires `EXECUTION_PROVIDER=ecs`; the [product delivery status](./docs/product.md#tier-2-delivery-status) distinguishes that built provider from pending acceptance and production deployment.
- [Primitives](./packages/primitives/CONTEXT.md): `packages/primitives`. Patch-owned tables and file stores, additive provisioning, schema and resource revisions, system columns, refs, bounded row operations, immutable file objects, authorised file handles, staged uploads and the declared member directory. Shared-table and shared-store declarations grant no authority; reads check the source's live access and cumulative inventory.
- [Integrations](./packages/integrations/CONTEXT.md): `packages/integrations`. Company Postgres connections, encrypted credentials, immutable schema snapshots, the member-readable `connections` API group, constrained runtime reads, generated relation clients, local fixtures and admin connection pages with recent calls. Publish binds connected identities and exact metadata revisions
- [Publishing](./packages/patchy/CONTEXT.md) — `packages/patchy` and `packages/sdk`, sharing one glossary:
  - `packages/patchy`: the single `patchy` package's CLI, config builders, browser client and local PGlite dev runtime; patch-repo initialization and publishing, transactional refresh, company tool and data-source discovery through `list`, owner lifecycle commands and description sync, declaration editing, managed files, global skill setup and project skills, and fixtures
  - `packages/sdk`: the instance's current release metadata, immutable package artifact, the public front door (`/llms.txt` and the installer), bearer-protected finished-file generation, and canonical project skill sources. SDK distribution is part of Publishing, separate from page serving

## Shared kernel

- `packages/core`: the safe-HTML policy, first-party card and app shells, shared component set and escape helpers, and shared ID/crypto primitives. No `CONTEXT.md`: a term it defines belongs to the context that introduced it, and a decision touching it goes in the root `docs/adr/`.

## Infrastructure

Supporting packages rather than product contexts; their glossaries define only the terms their consumers need.

- `packages/api` — the wire schemas and the `HttpApi` both sides speak: the server implements it, the CLI's client is derived from it, `docs/API.md` is rendered from it, and the shell validates runtime operations with it. Belongs to neither side; see [ADR-0002](./docs/adr/ADR-0002-api-is-the-contract-package.md). No `CONTEXT.md`: its terms are the contexts' own
- [SQL](./packages/sql/CONTEXT.md) — `packages/sql`, the Postgres client and Effect's Migrator every capability migrates through; owns no tables ([ADR-0003](./docs/adr/ADR-0003-postgres-only.md))
- [Company database](./packages/company-database/CONTEXT.md) — `packages/company-database`, company placement, lazy database creation, bounded pools, patch and file locks, cumulative inventory and orphan reclamation; the same inventory over PGlite for patch development ([ADR-0009](./docs/adr/ADR-0009-one-postgres-database-per-company.md))
- [Content store](./packages/content-store/CONTEXT.md): `packages/content-store`, the object store a patch's bytes go into; a filesystem layer for development and tests, and a Neon Object Storage S3 layer
- [Analytics](./packages/analytics/CONTEXT.md) — `packages/analytics`, business events and per-hop wide events, with stdout and a shared optional PostHog client
- [Limits](./packages/limits/CONTEXT.md) — `packages/limits`, the contract and operating limits registry, company overrides with history, and the fixed-window rate limiter behind every per-minute limit
- [Hosting](./apps/server/CONTEXT.md) — `apps/server`, the process that assembles and runs the hosting server. Its `CONTEXT.md` holds only wiring terms

## Relationships

- **Publishing → `api`**: publishes through the shared wire contract using a user-owned machine token
- **Publishing (`sdk`) → Primitives, Integrations, Patches, Content store, `api`**: retains advertised release archives in the content store and composes generated clients and context from primitive definitions and integration snapshots the caller may use
- **Publishing (`patchy/dev`) → Runtime, Execution/local, Execution/inspection, Primitives, Integrations, Company database, Content store, Limits**: composes the hosted handler engine and callback path over PGlite and fixtures, with the machine's user and a non-admin colleague on separate listeners. Dev bundles neither the fleet controller nor the AWS SDK.
- **`patchy/dev` → `serving/shell`**: serves the production renderer, broker and sandbox policies through the infrastructure-free shell export
- **Serving → Patches, Auth**: relies on Patches for content, sharing, visits and lifecycle notices with restore-source checks, and on Auth for viewer identity and session admission. Serving links to the card and restore routes without importing Portal.
- **Portal → Patches, Companies, Auth, Runtime, Integrations, `core`**: reads the company inventory and manages patches through Patches, coordinates Companies' user deactivation/reactivation with selected patch changes in one transaction, admits browser sessions through Auth, reads a patch's runtime log for its owner and admins through Runtime, naming the connections its calls went to through Integrations, and composes the shared app shell and components.
- **Patches → Content store, Execution/inspection**: owns stored patch content through publication and reclamation, and re-derives server-handler descriptors from stored bytes in a throwaway execution process.
- **Runtime → Auth, Limits, Analytics, SQL, `api`**: admits the viewer, enforces invocation and callback limits, owns transactions and settlement, records attribution and exact metering, and emits wide events. It owns cross-host wake delivery and document streams. Own-resource callbacks act as the patch; company callbacks recheck the initiating viewer's live session and membership.
- **Patches → Runtime**: supplies Runtime's loaded-version lookup: the manifest, effective sharing scope, owning company and server-stamped wire version; current-source lookup supplies shared-table and shared-store liveness without platform persistence inside primitive operations.
- **Execution → Runtime, `api`, SQL, Limits, Analytics**: implements Runtime's admitted-work `Executor` and company `ExecutionLifecycle` ports. The host fleet controller owns task persistence, binding history, the housekeeping lease and breaker. The engine, supervisor and inspection entrypoints import no platform persistence. Runtime never imports Execution.
- **Hosting → Runtime, Execution, Patches**: supplies loaded versions and operation handlers, selects the ECS executor for production or local execution for dev/tests, and wires private management and callback listeners. Runtime imports neither Patches, Primitives nor Integrations.
- **Primitives → Company database, Runtime, Content store**: provisions tables and stores under a patch lock and implements row and file operations under the admitted loaded-version binding; file indexes point to immutable byte objects
- **Hosting → Companies, Primitives**: adapts Companies' directory reads to Primitives' `MemberDirectory` port. Companies commits directory revisions with user changes and announces resource keys after commit; Primitives owns the declared directory operations and member-column assignment checks.
- **Companies → Hosting → Runtime**: Companies commits directory revisions and exposes after-commit change facts without importing Runtime or Primitives. Hosting publishes those resource wakes to Runtime. Dev instead supplies the two mount identities.
- **Patches → Primitives, Integrations, Company database**: resolves declarations, diffs before storing bytes, then provisions under the platform patch-row lock and returns cumulative inventory metadata
- **Patches → Companies**: joins company users for owner names and deactivation status in discovery, cards and lifecycle warnings.
- **Integrations → Runtime, Auth**: supplies Postgres handlers under loaded-version binding, records discovery with the acting admin, and mounts connection pages and the admin-only recent-calls reader behind the existing session and company-role boundary
- **Companies, Auth, Patches, Integrations → SQL**: persist their own domain data in the platform Postgres database
- **Company database → SQL, Content store**: keeps placements in the platform database, inventories in each company database, and reclaims unreferenced file objects
- **Auth, Patches → Analytics**: report business events
- **Hosting → Analytics**: opens a request event for every request outside the runtime path; Auth, Patches, Serving and Portal name its viewer, patch and version where they resolve them
- **Auth → Companies**: relies on company membership, roles and deactivation to authenticate users and machines
- **Hosting, Auth, Patches → Limits**: rely on shared rate limiting for API access, device login and publishing
- **Limits → SQL**: persists company overrides, their configuration revisions and change history.
- **Integrations → Companies**: a company owns its connections; active members read their safe metadata and admins manage them
- **Hosting → runtime packages**: coordinates their lifetime, including database setup, API protection, page serving and deletion sweeping

## Decisions

System-wide decisions are in [`docs/adr/`](./docs/adr/): ADR-0002 (the `api` contract package), ADR-0003 (Postgres only), ADR-0004 (the CLI contract for agents), ADR-0005 (one registrable domain for pages, API and Account Portal), ADR-0006 (Clerk holds the browser session; the shell keeps it fresh), [ADR-0007](./docs/adr/ADR-0007-patchy-holds-the-company.md) (Patchy holds the company; Clerk knows the user), and [ADR-0008](./docs/adr/ADR-0008-every-bearer-is-somebody.md) (Every bearer is somebody: the machine token). Product decisions not yet built are recorded in `docs/product.md`, and the PR that builds one writes its ADR. A superseded ADR is deleted, not kept: its replacement names what it replaced and git holds the old text.

Company database placement, provisioning, pooling and the local PGlite boundary are recorded in [ADR-0009](./docs/adr/ADR-0009-one-postgres-database-per-company.md).

The sandboxed browser, document-bound broker and tier-scoped serving guarantees are recorded in [ADR-0010](./docs/adr/ADR-0010-sandboxed-frame-and-broker.md).

One package, exact-current tooling and stable deployed wire contracts are recorded in [ADR-0011](./docs/adr/ADR-0011-one-package-one-release.md).

The credential-free handler engine, private guest wire and hosting contracts are recorded in [ADR-0012](./docs/adr/ADR-0012-credential-free-execution-service.md).
