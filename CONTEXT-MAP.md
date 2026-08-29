# Context Map

## Contexts

- [Hosting](./apps/server/CONTEXT.md) — receives uploads and serves published pages; owns `@patchy/db`, `@patchy/storage`, `@patchy/config`
- [Auth](./packages/auth/CONTEXT.md) — `packages/auth`, tokens and principals, self-service minting and its quota, revocation, and the `auth` API group
- [Analytics](./packages/analytics/CONTEXT.md) — `packages/analytics`, the event service the hosting server reports business moments through
- [Limits](./packages/limits/CONTEXT.md) — `packages/limits`, the fixed-window rate limiter behind the hosting server's per-minute limits
- [SQL](./packages/sql/CONTEXT.md) — `packages/sql`, the Postgres client and Effect's Migrator every capability package migrates through; owns no tables
- [Publishing](./packages/cli/CONTEXT.md) — `packages/cli` and the bundled skill, the `patchy` CLI package agents use to put pages up

## Relationships

- **Publishing → Hosting, Auth**: the CLI creates and updates drafts through the hosting HTTP API, authenticated by tokens Auth mints
- **Hosting → Auth**: the server authenticates every protected request through `Tokens` and serves the `auth` group's handlers through its runtime seam; the principal a handler receives is Auth's, the scope a route demands is Hosting's
- **Auth → Analytics, Limits, SQL**: minting reports through `Analytics`, spends the per-minute mint limit through `Limits`, and reads and writes its tables through the `SQL` client; the JSON driver in `@patchy/db` stands in for the Postgres tokens layer until the `patches` port deletes it
- **Hosting → Analytics, Limits**: the server's emitters report through `Analytics`, and its per-minute limits spend attempts through `Limits`; both are consumed through one runtime seam until the server itself moves onto Effect
- **Shared kernel** (`packages/core`): the safe-HTML policy and ID/crypto primitives both contexts depend on; terms it defines belong to whichever context introduced them
- **Contract** (`packages/api`): the wire schemas and `HttpApi` both contexts speak — the server encodes through them, the CLI decodes through them, `docs/API.md` is rendered from them. It belongs to neither context; see [ADR-0002](./docs/adr/ADR-0002-api-is-the-contract-package.md)
