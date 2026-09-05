# Context Map

Patchy Cloud is one deployment: the hosting server on one side, the `patchy` CLI agents publish through on the other, and a wire contract between them. The contexts below are the product's, not the packages': each names the package that implements it today, or says that no code exists yet. A context with no code keeps its `CONTEXT.md` at the path its package will take, so the glossary is written before the code and the package is born beside it. `docs/product.md` carries the product's shape; the glossaries carry its words.

## Contexts

- [Patches](./packages/patches/CONTEXT.md) — `packages/patches`. Patches and immutable versions, user ownership, company/public sharing, the upload contract, owner deletion, retention and its sweep, the owner quota, and the `patches` API group. Patch repos, declared tiers, primitives, human-readable addresses and retirement remain future work
- [Serving](./packages/serving/CONTEXT.md) — `packages/serving`. Tier 0 pages, the login door, serving guarantees, admitted visits and trusted-proxy attribution. Higher runtimes, the connect door and patch identity remain future work
- [Companies](./packages/companies/CONTEXT.md) — `packages/companies`. Companies and handles, users and roles, create-or-join, invitations, the company page, deactivation and reactivation. Groups, verified domains, SSO, billing, suspension and the operator's surfaces remain future work
- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`. Clerk session verification and viewers, user-owned machine tokens, device login, identity, revocation and bearer parsing, the sign-in and sign-out pages, Your machines, the `auth` API group and the shared dev seed
- [Integrations](./packages/integrations/CONTEXT.md) — no code yet. The company-scoped primitive that reaches outside systems: integration, connection and personal connection, connection handle, the typed client patch code is handed, the call log
- [Publishing](./packages/cli/CONTEXT.md) — `packages/cli` and the bundled skill, the `patchy` CLI agents use to publish patches

## Shared kernel

- `packages/core` — the safe-HTML policy, first-party HTML shell and escape helpers, and shared ID/crypto primitives. No `CONTEXT.md`: a term it defines belongs to the context that introduced it, and a decision touching it goes in the root `docs/adr/`.

## Infrastructure

Supporting packages rather than product contexts; their glossaries define only the terms their consumers need.

- `packages/api` — the wire schemas and the `HttpApi` both sides speak: the server implements it, the CLI's client is derived from it, `docs/API.md` is rendered from it. Belongs to neither side; see [ADR-0002](./docs/adr/ADR-0002-api-is-the-contract-package.md). No `CONTEXT.md`: its terms are the contexts' own
- [SQL](./packages/sql/CONTEXT.md) — `packages/sql`, the Postgres client and Effect's Migrator every capability migrates through; owns no tables ([ADR-0003](./docs/adr/ADR-0003-postgres-only.md))
- [Content store](./packages/content-store/CONTEXT.md) — `packages/content-store`, the object store a patch's bytes go into; a filesystem layer and an Azure Blob layer
- [Analytics](./packages/analytics/CONTEXT.md) — `packages/analytics`, the event service Patches and Auth report business moments through
- [Limits](./packages/limits/CONTEXT.md) — `packages/limits`, the fixed-window rate limiter behind every per-minute limit
- [Hosting](./apps/server/CONTEXT.md) — `apps/server`, the process: composes every package into one Effect layer, guards `/api/*`, forks the sweep, listens. Its `CONTEXT.md` holds only wiring terms

## Relationships

- **Publishing → `api`**: the CLI creates and updates patches through the derived client and authenticates with a user-owned machine token
- **Serving → Patches, Auth**: the page handler reads metadata through `Patches`, checks sharing against the admission supplied by Auth's session helpers, then reads HTML through `Content` and records an admitted visit through `Patches`. Serving never accesses the content store directly; its login middleware is scoped to the two patch routes
- **Patches → Content store**: the upload contract and the sweep put, get and delete a patch's bytes through `ContentStore`; nothing else touches them
- **Companies, Auth, Patches → SQL**: all query the shared Postgres client and own separate migration records. `patch_versions` references `machine_tokens`, but Patches imports neither Auth nor Companies: its handlers receive identity from bearer middleware. Companies revokes a deactivated user's machine tokens in the same transaction as deactivation, without importing Auth
- **Auth, Patches → Analytics**: reports business events with the user as principal, or no user for expiry. Auth reports a machine token minted by the device-login poll and whether it replaced an old key
- **Auth → Companies**: Companies owns the users and companies that bearer authentication joins with `machine_tokens`; its services own membership, roles and deactivation. Auth mounts Companies' create-or-join and company page behind its session boundary
- **Hosting, Auth, Patches → Limits**: Hosting limits device-login starts and protected API attempts by address; Auth limits polls by device code and confirm-page lookups by user; Patches limits uploads and creates by machine token
- **Integrations → Companies, Serving**: a future connection belongs to a company or user, and a patch will reach it through the cloud within the authenticated viewer's permissions. The integration and higher-runtime boundaries are not implemented yet
- **Hosting → runtime packages**: runs Companies', Auth's and Patches' migrations, mounts both API groups with Auth's bearer middleware on protected endpoints and the guard ahead of the router, mounts Auth's pages (including Companies' pages) and Serving's pages, and forks Patches' `ExpirySweep` in the server's scope

## Decisions

System-wide decisions are in [`docs/adr/`](./docs/adr/): ADR-0002 (the `api` contract package), ADR-0003 (Postgres only), ADR-0004 (the CLI contract for agents), ADR-0005 (one registrable domain for pages, API and Account Portal), ADR-0006 (Clerk holds the browser session; the shell keeps it fresh), [ADR-0007](./docs/adr/ADR-0007-patchy-holds-the-company.md) (Patchy holds the company; Clerk knows the user), and [ADR-0008](./docs/adr/ADR-0008-every-bearer-is-somebody.md) (Every bearer is somebody: the machine token). Product decisions not yet built are recorded in `docs/product.md`, and the PR that builds one writes its ADR. A superseded ADR is deleted, not kept: its replacement names what it replaced and git holds the old text.
