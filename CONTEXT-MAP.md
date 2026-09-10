# Context Map

Patchy Cloud is one deployment: the hosting server on one side, the `patchy` CLI agents publish through on the other, and a wire contract between them. The contexts below are the product's, not the packages': each names the package that implements it today, or says that no code exists yet. A context with no code keeps its `CONTEXT.md` at the path its package will take, so the glossary is written before the code and the package is born beside it. `docs/product.md` carries the product's shape; the glossaries carry its words.

## Contexts

- [Patches](./packages/patches/CONTEXT.md) — `packages/patches`. Patches and immutable versions, company-scoped names, manifests and replay-safe publish keys, additive table and store provisioning at publish, owner inventory, user ownership, company/public sharing, owner deletion, retention and its sweep, the owner quota, release metadata, and the `patches` API group. Patch repos, higher-tier serving and retirement remain future work
- [Serving](./packages/serving/CONTEXT.md) — `packages/serving`. Patch addresses and version/content URLs, tier 0 pages, the login door, serving guarantees, admitted visits and trusted-proxy attribution. Higher runtimes, the connect door and patch identity remain future work
- [Companies](./packages/companies/CONTEXT.md) — `packages/companies`. Companies and handles, users and roles, create-or-join, invitations, the company page, deactivation and reactivation. Groups, verified domains, SSO, billing, suspension and the operator's surfaces remain future work
- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`. Clerk session verification and viewers, user-owned machine tokens, device login, identity, revocation and bearer parsing, the sign-in and sign-out pages, Your machines, the `auth` API group and the shared dev seed
- [Runtime](./packages/runtime/CONTEXT.md) — `packages/runtime`. Browser-only operation admission, loaded-version binding, acting identity, wire versions, dispatch and the runtime log. Admits `me`, owned-table operations, shared-table reads and file operations supplied by Primitives, including live-authorized bytes routes; integration handlers arrive with their capabilities
- [Primitives](./packages/primitives/CONTEXT.md) — `packages/primitives`. Patch-owned table and file-store definitions, one additive diff and provisioning, schema revisions, system columns, refs, bounded row operations and immutable file objects over Postgres and PGlite. Shared-table declarations grant no authority: reads check the source's live access and cumulative inventory
- [Integrations](./packages/integrations/CONTEXT.md) — no code yet. The company-scoped primitive that reaches outside systems: integration, connection and personal connection, connection handle, the typed client patch code is handed, the call log
- [Publishing](./packages/cli/CONTEXT.md) — `packages/cli` and the bundled skill, the `patchy` CLI agents use to publish patches

## Shared kernel

- `packages/core` — the safe-HTML policy, first-party HTML shell and escape helpers, and shared ID/crypto primitives. No `CONTEXT.md`: a term it defines belongs to the context that introduced it, and a decision touching it goes in the root `docs/adr/`.

## Infrastructure

Supporting packages rather than product contexts; their glossaries define only the terms their consumers need.

- `packages/api` — the wire schemas and the `HttpApi` both sides speak: the server implements it, the CLI's client is derived from it, `docs/API.md` is rendered from it. Belongs to neither side; see [ADR-0002](./docs/adr/ADR-0002-api-is-the-contract-package.md). No `CONTEXT.md`: its terms are the contexts' own
- [SQL](./packages/sql/CONTEXT.md) — `packages/sql`, the Postgres client and Effect's Migrator every capability migrates through; owns no tables ([ADR-0003](./docs/adr/ADR-0003-postgres-only.md))
- [Company database](./packages/company-database/CONTEXT.md) — `packages/company-database`, company placement, lazy database creation, bounded pools, patch locks, cumulative inventory and orphan reclamation; the same inventory over PGlite for patch development ([ADR-0009](./docs/adr/ADR-0009-one-postgres-database-per-company.md))
- [Content store](./packages/content-store/CONTEXT.md) — `packages/content-store`, the object store a patch's bytes go into; a filesystem layer and an Azure Blob layer
- [Analytics](./packages/analytics/CONTEXT.md) — `packages/analytics`, the event service Patches and Auth report business moments through
- [Limits](./packages/limits/CONTEXT.md) — `packages/limits`, the fixed-window rate limiter behind every per-minute limit
- [Hosting](./apps/server/CONTEXT.md) — `apps/server`, the process that assembles and runs the hosting server. Its `CONTEXT.md` holds only wiring terms

## Relationships

- **Publishing → `api`**: publishes through the shared wire contract using a user-owned machine token
- **Serving → Patches, Auth**: relies on Patches for content, sharing and visits, and on Auth for viewer identity and session admission
- **Patches → Content store**: owns the lifecycle of stored patch content, from publication through expiry
- **Runtime → Auth, Limits, SQL**: admits the browser session as the acting identity, limits calls per viewer and owning patch, and records mutations and integration calls before execution
- **Patches → Runtime**: supplies Runtime's loaded-version lookup: the manifest, effective sharing scope, owning company and server-stamped wire version; current-source lookup supplies shared-table liveness without platform persistence inside primitive operations
- **Hosting → Runtime, Patches**: supplies the loaded-version layer and the operation handler map; Runtime does not import Patches
- **Primitives → Company database, Runtime, Content store**: provisions tables and stores under a patch lock and implements row and file operations under the admitted loaded-version binding; file indexes point to immutable byte objects
- **Patches → Primitives, Company database**: resolves shared-table declarations, diffs before storing bytes, then provisions under the platform patch-row lock and returns cumulative inventory metadata
- **Integrations → Runtime, Auth** (planned): implements integration operations as the admitted viewer
- **Companies, Auth, Patches → SQL**: persist their own domain data in the shared Postgres database
- **Company database → SQL, Content store**: keeps placements in the platform database, inventories in each company database, and reclaims unreferenced file objects
- **Auth, Patches → Analytics**: report business events
- **Auth → Companies**: relies on company membership, roles and deactivation to authenticate users and machines
- **Hosting, Auth, Patches → Limits**: rely on shared rate limiting for API access, device login and publishing
- **Integrations → Companies, Serving**: a future connection belongs to a company or user, and a patch will reach it through the cloud within the authenticated viewer's permissions. The integration and higher-runtime boundaries are not implemented yet
- **Hosting → runtime packages**: coordinates their lifetime, including database setup, API protection, page serving and retention sweeping

## Decisions

System-wide decisions are in [`docs/adr/`](./docs/adr/): ADR-0002 (the `api` contract package), ADR-0003 (Postgres only), ADR-0004 (the CLI contract for agents), ADR-0005 (one registrable domain for pages, API and Account Portal), ADR-0006 (Clerk holds the browser session; the shell keeps it fresh), [ADR-0007](./docs/adr/ADR-0007-patchy-holds-the-company.md) (Patchy holds the company; Clerk knows the user), and [ADR-0008](./docs/adr/ADR-0008-every-bearer-is-somebody.md) (Every bearer is somebody: the machine token). Product decisions not yet built are recorded in `docs/product.md`, and the PR that builds one writes its ADR. A superseded ADR is deleted, not kept: its replacement names what it replaced and git holds the old text.

Company database placement, provisioning, pooling and the local PGlite boundary are recorded in [ADR-0009](./docs/adr/ADR-0009-one-postgres-database-per-company.md).
