# Context Map

Patchy Cloud is one deployment: the hosting server on one side, the `patchy` CLI agents publish through on the other, and a wire contract between them. The contexts below are the product's, not the packages': each names the package that implements it today, or says that no code exists yet. A context with no code keeps its `CONTEXT.md` at the path its package will take, so the glossary is written before the code and the package is born beside it. `docs/product.md` carries the product's shape; the glossaries carry its words.

## Contexts

- [Patches](./packages/patches/CONTEXT.md) — `packages/patches`. The unit: patch, version, patch repo, declared tier, publish, owner, sharing scope and address, retire and delete, the primitives a patch declares. Today also the upload contract, the retention clock and its sweep, the patch quota, and the `patches` API group
- [Serving](./packages/serving/CONTEXT.md) — `packages/serving`. A patch reaching its viewer, at every tier: the page, the doors in front of it (login, connect), the serving guarantees, the visit, the trusted-proxy schema, and the identity patch code acts as from tier 1 up. Today it serves tier 0; the tier 1 and tier 2 runtimes build on it
- [Companies](./packages/companies/CONTEXT.md) — `packages/companies`. The tenant and who is in it: company and handle, users and roles, invites, deactivation and reactivation; groups, verified domains, SSO, suspension and the operator remain future work
- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`. Who a caller is: machine tokens, identity, revocation and bearer parsing, the `auth` API group and the shared dev seed; browser sessions and device login arrive next
- [Integrations](./packages/integrations/CONTEXT.md) — no code yet. The company-scoped primitive that reaches outside systems: integration, connection and personal connection, connection handle, the typed client patch code is handed, the call log
- [Publishing](./packages/cli/CONTEXT.md) — `packages/cli` and the bundled skill, the `patchy` CLI agents use to publish patches

## Shared kernel

- `packages/core` — the safe-HTML policy and the ID/crypto primitives every context depends on. No `CONTEXT.md`: a term it defines belongs to the context that introduced it, and a decision touching it goes in the root `docs/adr/`.

## Infrastructure

Packages that hold no domain vocabulary of their own; each defines the few terms its consumers need in its `CONTEXT.md`.

- `packages/api` — the wire schemas and the `HttpApi` both sides speak: the server implements it, the CLI's client is derived from it, `docs/API.md` is rendered from it. Belongs to neither side; see [ADR-0002](./docs/adr/ADR-0002-api-is-the-contract-package.md). No `CONTEXT.md`: its terms are the contexts' own
- [SQL](./packages/sql/CONTEXT.md) — `packages/sql`, the Postgres client and Effect's Migrator every capability migrates through; owns no tables ([ADR-0003](./docs/adr/ADR-0003-postgres-only.md))
- [Content store](./packages/content-store/CONTEXT.md) — `packages/content-store`, the object store a patch's bytes go into; a filesystem layer and an Azure Blob layer
- [Analytics](./packages/analytics/CONTEXT.md) — `packages/analytics`, the event service Auth and Patches report business moments through
- [Limits](./packages/limits/CONTEXT.md) — `packages/limits`, the fixed-window rate limiter behind every per-minute limit
- [Hosting](./apps/server/CONTEXT.md) — `apps/server`, the process: composes every package into one Effect layer, guards `/api/*`, forks the sweep, listens. Its `CONTEXT.md` holds only wiring terms

## Relationships

- **Publishing → `api`**: the CLI creates and updates patches through the derived client and authenticates with a user-owned machine token
- **Serving → Patches**: a page reads the record and its HTML through `Content` and records the visit through `Patches`; Serving never touches bytes and never imports Auth. Once login lands, the login door asks Auth who opened the page and Patches whether they may
- **Patches → Content store**: the upload contract and the sweep put, get and delete a patch's bytes through `ContentStore`; nothing else touches them
- **Auth, Patches → SQL, Analytics**: both query through the `SQL` client and report business events with the user as principal. `patch_versions` references `machine_tokens`, but Patches never imports Auth: every handler receives the identity from bearer middleware. Patches spends its per-machine rate limits through `Limits`
- **Auth → Companies**: Companies owns the users and companies that bearer authentication joins with `machine_tokens`; its services own membership, roles and deactivation
- **Integrations → Companies, Serving**: a connection is a company's or a user's, and a patch reaches it only through the cloud, as the viewer Serving established. Not yet in code
- **Hosting → everything**: mounts both API groups behind Auth's bearer middleware, the guard ahead of them, Serving's pages, and forks Patches' `ExpirySweep`; nothing here is a term of its own

## Decisions

System-wide decisions are in [`docs/adr/`](./docs/adr/): ADR-0002 (the `api` contract package), ADR-0003 (Postgres only), ADR-0004 (the CLI contract for agents), ADR-0005 (one registrable domain for pages, API and Account Portal), ADR-0006 (Clerk holds the browser session; the shell keeps it fresh), and [ADR-0007](./docs/adr/ADR-0007-patchy-holds-the-company.md) (Patchy holds the company; Clerk knows the user). Product decisions not yet built are recorded in `docs/product.md`, and the PR that builds one writes its ADR. A superseded ADR is deleted, not kept: its replacement names what it replaced and git holds the old text.
