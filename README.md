# Patchy Cloud

A cloud for a company's internal tools, built for the agentic era.

People at a company build **patches** — anything from a static page to a full CRM — and deploy them here. Anyone can build one: a person who codes, or a person whose agent codes for them. Agents are good at CLIs and at running code locally, so the CLI is the front door: tell your agent to publish, and the patch is up. Log in once and reach everything in your company you have access to.

A patch runs at one of a few **tiers**: tier 0 is a static page with no code running anywhere, tier 1 runs in the viewer's browser, tier 2 has its own hosted runtime. Patches reach a company's connected systems — its database, Google Workspace, Salesforce — through **primitives** the cloud provides, never through credentials of their own. [docs/product.md](docs/product.md) is the shape of all this.

## Where it is today

Tier 0. An agent hands the server one self-contained HTML file and gets back an unlisted URL. Companies, login and the integration layer are written down in `docs/product.md` and not yet in code.

This repository is a full-history copy of [PatchPage](https://github.com/allisonmahmood/PatchPage), taken in a different direction. PatchPage remains a separate, free product with its own instance; nothing here runs it or publishes to it, and commits from before the split describe PatchPage, not Patchy Cloud.

## Try it

```sh
pnpm install && pnpm dev
pnpm patchy upload examples/plan.html
```

`pnpm dev` runs a complete instance for the worktree you are in — embedded Postgres, migrations, a seeded company with a working token — and prints where it is; `pnpm patchy` runs the CLI against it. `pnpm dev stop` shuts it down. The runner is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), the CLI's commands and contract in [packages/cli/README.md](packages/cli/README.md).

**Unlisted, not private.** Page URLs are long, unguessable and served `noindex`, but anyone with the link can open or reshare one. Don't publish secrets.

## Repository layout

A Turborepo monorepo managed with pnpm. [AGENTS.md](AGENTS.md) is the guide to working in it, for people and agents alike.

- `apps/server` — the Effect HTTP server: wires the capability packages into one layer, guards `/api/*`, and listens (`@patchy/server`).
- `packages/cli` — `@patchy/cli`, the `patchy` command-line publisher.
- `packages/core` — shared HTML validation, hashing, and ID helpers (`@patchy/core`).
- `packages/api` — the wire contract: schemas, the `HttpApi`, the derived client (`@patchy/api`).
- `packages/auth` — tokens, principals, self-service minting, revocation, and the `auth` API group (`@patchy/auth`).
- `packages/patches` — patches and versions, the upload contract, retention and the expiry sweep, owner-only deletion, and the `patches` API group (`@patchy/patches`).
- `packages/serving` — the serving guarantees, the page routes, and the trusted-proxy schema (`@patchy/serving`).
- `packages/content-store` — the object store for a patch's bytes, with filesystem and Azure Blob layers (`@patchy/content-store`).
- `packages/sql`, `packages/analytics`, `packages/limits` — the Postgres client and Migrator, the event service, the rate limiter.
- `skills/patchy` — the agent skill that teaches an assistant to produce safe static HTML and publish it.
- `examples/plan.html` — a Patchy-styled starter patch.

`pnpm test`, `pnpm typecheck` and `pnpm lint` are the checks; `pnpm test:all` adds the suites CI runs and reports the ones it skipped locally.

## Security

Report vulnerabilities privately by following the [security policy](SECURITY.md).

## License

All rights reserved for now — see [LICENSE](LICENSE). Outside contributions are not being accepted yet.
