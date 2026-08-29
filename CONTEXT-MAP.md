# Context Map

## Contexts

- [Hosting](./apps/server/CONTEXT.md) — `apps/server`, the process: wires every capability into one Effect layer, guards `/api/*`, listens
- [Serving](./packages/serving/CONTEXT.md) — `packages/serving`, the serving guarantees, the page routes and the trusted-proxy schema
- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`, tokens and principals, self-service minting and its quota, revocation, and the `auth` API group
- [Patches](./packages/patches/CONTEXT.md) — `packages/patches`, patch and version records, the upload contract, the retention clock and its sweep, pins, moderation, the patch quota, and the `patches` API group
- [Analytics](./packages/analytics/CONTEXT.md) — `packages/analytics`, the event service the hosting server reports business moments through
- [Content store](./packages/content-store/CONTEXT.md) — `packages/content-store`, the object store a patch's bytes go into; a filesystem layer and an Azure Blob layer
- [Limits](./packages/limits/CONTEXT.md) — `packages/limits`, the fixed-window rate limiter behind the hosting server's per-minute limits
- [SQL](./packages/sql/CONTEXT.md) — `packages/sql`, the Postgres client and Effect's Migrator every capability package migrates through; owns no tables
- [Publishing](./packages/cli/CONTEXT.md) — `packages/cli` and the bundled skill, the `patchy` CLI package agents use to put pages up

## Relationships

- **Publishing → Hosting, Auth, Patches**: the CLI creates and updates patches through the hosting HTTP API, authenticated by tokens Auth mints
- **Hosting → Auth, Patches, Serving**: the server mounts both API groups behind Auth's bearer middleware, its guard identifies a caller through Auth for the requests the router never matches, it mounts Serving's pages, and it forks Patches' `ExpirySweep`; the principal a handler receives is Auth's, the scope a route demands is the handler's
- **Serving → Patches**: a page reads the record and its HTML through `Content` and records the visit through `Patches`; Serving never touches bytes and never imports Auth
- **Auth → Analytics, Limits, SQL**: minting reports through `Analytics`, spends the per-minute mint limit through `Limits`, and reads and writes its tables through the `SQL` client
- **Patches → Analytics, Limits, Content store, SQL**: uploads and moderation report through `Analytics`, a create spends the per-token create limit through `Limits`, the upload contract and the sweep put, get and delete a patch's bytes through `ContentStore`, and every row lives in the `SQL` client; `patch_versions` names the Auth token that made a version and the visit rule reads whether it is revoked, so the two capabilities share one database and Patches never imports Auth
- **Hosting → Analytics, Limits**: the guard's protected-API limit spends attempts through `Limits`; Analytics is built in the server's scope so its finalizer flushes on shutdown
- **Shared kernel** (`packages/core`): the safe-HTML policy and ID/crypto primitives both contexts depend on; terms it defines belong to whichever context introduced them
- **Contract** (`packages/api`): the wire schemas and `HttpApi` both contexts speak — the server encodes through them, the CLI decodes through them, `docs/API.md` is rendered from them. It belongs to neither context; see [ADR-0002](./docs/adr/ADR-0002-api-is-the-contract-package.md)
