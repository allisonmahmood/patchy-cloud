# Context Map

Patchy Cloud is one deployment: the hosting server on one side, the `patchy` CLI agents publish through on the other, and a wire contract between them. The contexts below are the product's, not the packages': each names the package that implements it today, or says that no code exists yet. A context with no code keeps its `CONTEXT.md` at the path its package will take, so the glossary is written before the code and the package is born beside it. `docs/product.md` carries the product's shape; the glossaries carry its words.

## Contexts

- [Patches](./packages/patches/CONTEXT.md) — `packages/patches`. The unit: patch, version, patch repo, declared tier, publish, owner, sharing scope and address, retire and delete, the primitives a patch declares. Today also the upload contract, the retention clock and its sweep, pins, moderation, the patch quota, and the `patches` API group
- [Serving](./packages/serving/CONTEXT.md) — `packages/serving`. A patch reaching its viewer, at every tier: the page, the doors in front of it (login, connect), the serving guarantees, the visit, the trusted-proxy schema, and the identity patch code acts as from tier 1 up. Today it serves tier 0; the tier 1 and tier 2 runtimes build on it
- [Companies](./packages/companies/CONTEXT.md) — no code yet. The tenant and who is in it: company and handle, user, member and admin, group, invite, verified domain, SSO, deactivation, suspension, and the operator
- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`. Who a caller is: the browser session, device login, the machine token and _Your machines_, the principal behind a credential, bearer parsing. Today also self-service minting and its quota, which retire with login, and the `auth` API group
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

- **Publishing → `api`**: the CLI creates and updates patches through the derived client and never through hand-built requests; it authenticates with tokens Auth issues (self-service today, the machine token once login lands)
- **Serving → Patches**: a page reads the record and its HTML through `Content` and records the visit through `Patches`; Serving never touches bytes and never imports Auth. Once login lands, the login door asks Auth who opened the page and Patches whether they may
- **Patches → Content store**: the upload contract and the sweep put, get and delete a patch's bytes through `ContentStore`; nothing else touches them
- **Auth, Patches → SQL, Analytics, Limits**: both query through the `SQL` client, report through `Analytics` and spend their per-minute limits through `Limits`. They share one database (`patch_versions` names the token that made a version) but Patches never imports Auth: every handler receives the principal from the bearer middleware
- **Companies → Auth, Patches**: a user is a company's; Auth resolves a session or machine token to a user, Patches keys ownership and sharing scope on users and groups. Not yet in code
- **Integrations → Companies, Serving**: a connection is a company's or a user's, and a patch reaches it only through the cloud, as the viewer Serving established. Not yet in code
- **Hosting → everything**: mounts both API groups behind Auth's bearer middleware, the guard ahead of them, Serving's pages, and forks Patches' `ExpirySweep`; nothing here is a term of its own

## Decisions

System-wide decisions are in [`docs/adr/`](./docs/adr/): ADR-0002 (the `api` contract package), ADR-0003 (Postgres only), ADR-0004 (the CLI contract for agents), ADR-0005 (one registrable domain for pages, API and Account Portal), ADR-0006 (Clerk holds the browser session; the shell keeps it fresh). Product decisions not yet built are recorded in `docs/product.md`, and the PR that builds one writes its ADR, unless the decision constrains the build itself, in which case the ADR lands ahead of it, as ADR-0005 and ADR-0006 did. A superseded ADR is deleted, not kept: its replacement names what it replaced and git holds the old text. No package has a `docs/adr/` of its own yet; the first context-scoped decision creates one beside that package's `CONTEXT.md`.
