# Context Map

## Contexts

- [Hosting](./apps/server/CONTEXT.md) — receives uploads and serves published pages; owns `@patchy/db`, `@patchy/storage`, `@patchy/config`
- [Publishing](./packages/cli/CONTEXT.md) — `packages/cli` and the bundled skill, the `patchy` CLI package agents use to put pages up

## Relationships

- **Publishing → Hosting**: the CLI creates and updates drafts through the hosting HTTP API, authenticated by auth tokens the hosting context mints
- **Shared kernel** (`packages/core`): the safe-HTML policy and ID/crypto primitives both contexts depend on; terms it defines belong to whichever context introduced them
- **Contract** (`packages/api`): the wire schemas and `HttpApi` both contexts speak — the server encodes through them, the CLI decodes through them, `docs/API.md` is rendered from them. It belongs to neither context; see [ADR-0002](./docs/adr/ADR-0002-api-is-the-contract-package.md)
