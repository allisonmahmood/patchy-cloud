# Context Map

Patchy Cloud is one deployment: the hosting server on one side, the `patchy` CLI agents publish through on the other, and a wire contract between them. The hosting side is cut into capability packages, each with its own `CONTEXT.md`; `apps/server` only wires them.

## Contexts

- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`, tokens and principals, self-service minting and its quota, revocation, and the `auth` API group
- [Patches](./packages/patches/CONTEXT.md) — `packages/patches`, patch and version records, the upload contract, the retention clock and its sweep, pins, moderation, the patch quota, and the `patches` API group
- [Serving](./packages/serving/CONTEXT.md) — `packages/serving`, the serving guarantees, the page routes and the trusted-proxy schema
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

- **Publishing → `api`**: the CLI creates and updates patches through the derived client and never through hand-built requests; it authenticates with tokens Auth mints (self-service, or minted for it by the Patchy Cloud operator)
- **Serving → Patches**: a page reads the record and its HTML through `Content` and records the visit through `Patches`; Serving never touches bytes and never imports Auth
- **Patches → Content store**: the upload contract and the sweep put, get and delete a patch's bytes through `ContentStore`; nothing else touches them
- **Auth, Patches → SQL, Analytics, Limits**: both query through the `SQL` client, report through `Analytics` and spend their per-minute limits through `Limits`. They share one database (`patch_versions` names the token that made a version) but Patches never imports Auth: every handler receives the principal from the bearer middleware
- **Hosting → everything**: mounts both API groups behind Auth's bearer middleware, the guard ahead of them, Serving's pages, and forks Patches' `ExpirySweep`; nothing here is a term of its own

## Decisions

System-wide decisions are in [`docs/adr/`](./docs/adr/): ADR-0002 (the `api` contract package), ADR-0003 (Postgres only), ADR-0004 (the CLI contract for agents). ADR-0000 and ADR-0001 are retired; the Effect v4 port that retired them is recorded on the [port map (#54)](https://github.com/allisonmahmood/patchy-cloud/issues/54). No package has a `docs/adr/` of its own yet; the first context-scoped decision creates one beside that package's `CONTEXT.md`.
