# Patchy Cloud

A cloud for a company's internal tools, built for the agentic era.

People at a company build **patches** — anything from a static page to a full CRM — and deploy them here. Anyone can build one: a person who codes, or a person whose agent codes for them. Agents are good at CLIs and at running code locally, so the CLI is the front door: tell your agent to publish, and the patch is up. Log in once and reach everything in your company you have access to.

A patch runs at one of a few **tiers**: tier 0 is a static page with no patch code running anywhere, tier 1 runs in the viewer's browser, tier 2 has its own hosted runtime. Patches reach a company's connected systems — its database, Google Workspace, Salesforce — through **primitives** the cloud provides, never through credentials of their own. [docs/product.md](docs/product.md) is the shape of all this.

## Where it is today

Tier 0. An agent hands the server one self-contained HTML file and gets back a URL, shared with the company by default or made public on purpose. Patches belong to users in companies; publishing uses user-owned machine tokens. Clerk holds the browser session, and the shell keeps it fresh while the patch runs no script.

`patchy login` hands the person a browser URL and code; after they confirm, the CLI's poll mints and saves the machine token. `patchy upload --share public` and `patchy share` change who can open a patch. **Your machines** lists and revokes keys and offers browser sign-out; the company page handles invites, roles, deactivation and reactivation. Higher tiers and integrations are still to come.

This repository is a full-history copy of [PatchPage](https://github.com/allisonmahmood/PatchPage), taken in a different direction. PatchPage remains a separate, free product with its own instance; nothing here runs it or publishes to it, and commits from before the split describe PatchPage, not Patchy Cloud.

## Try it

Use Node 22.13+ and the pnpm version in `package.json`. Before starting, load your **Clerk development keys** into the developer-owned `dev.env` as described in [Development: Clerk keys](docs/DEVELOPMENT.md#clerk-keys); shell exports alone do not configure the dev server.

```sh
pnpm install
pnpm dev
```

The runner starts embedded Postgres, applies the three baselines, seeds **Patchy Dev** and its admin's development machine token, and prints this worktree's API URL. In your browser, open that URL's `/join` page and click **Sign in**. Create or join a company when prompted. To use **Patchy Dev** as its admin instead, set the optional [`PATCHY_DEV_CLERK_USER_ID`](docs/DEVELOPMENT.md#seed) before starting.

Keep `PATCHY_API_TOKEN` unset so a saved login outranks the development seed, then log in the CLI:

```sh
pnpm patchy login
```

Open the printed verification URL in your signed-in browser, check the code, company and email, name the machine, and confirm. At a human terminal the command waits and saves the key. An agent runs `pnpm patchy login --json`, relays `verificationUrl` and `userCode` to the person, and after confirmation runs the returned `next` command through `pnpm patchy login --complete <userCode>`. The CLI never opens the browser or prints the key.

Once login reports success:

```sh
pnpm patchy whoami
pnpm patchy upload examples/plan.html
```

Open the upload's URL in the same signed-in browser. **Company scope is the default:** colleagues in that company can read the page, but a publishing key cannot open it. An agent reads company patches through its user's browser; only public patches fetch directly by URL. Choose `--share public` on upload only when the page is intended for anyone holding the link. Don't publish secrets.

`pnpm patchy` runs from source and discovers this worktree's instance automatically. `pnpm dev stop` shuts it down. The complete runner and login recipes are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and the CLI's commands and contract are in [packages/cli/README.md](packages/cli/README.md).

## Repository layout

A Turborepo monorepo managed with pnpm. [AGENTS.md](AGENTS.md) is the guide to working in it, for people and agents alike.

- `apps/server` — the Effect HTTP server: wires the capability packages into one layer, guards `/api/*`, and listens (`@patchy/server`).
- `packages/cli` — `@patchy/cli`, the `patchy` command-line publisher.
- `packages/core` — shared HTML validation, hashing, ID helpers, and the first-party page shell (`@patchy/core`).
- `packages/api` — the wire contract: schemas, the `HttpApi`, the derived client (`@patchy/api`).
- `packages/companies` — companies, users, roles, invites and membership lifecycle (`@patchy/companies`).
- `packages/auth` — browser sessions, the shared login door, device login, machine tokens, Your machines, bearer identity, revocation, the shared development seed and the `auth` API group (`@patchy/auth`).
- `packages/patches` — user-owned patches and versions, upload and sharing, retention and the expiry sweep, owner-only deletion, and the `patches` API group (`@patchy/patches`).
- `packages/serving` — the page routes and login door integration, sharing-aware CSP and caching, and the trusted-proxy schema (`@patchy/serving`).
- `packages/content-store` — the object store for a patch's bytes, with filesystem and Azure Blob layers (`@patchy/content-store`).
- `packages/sql`, `packages/analytics`, `packages/limits` — the Postgres client and Migrator, the event service, the rate limiter.
- `skills/patchy` — the agent skill that teaches an assistant to produce safe static HTML and publish it.
- `examples/plan.html` — a Patchy-styled starter patch.

`pnpm test`, `pnpm typecheck` and `pnpm lint` are the checks. `pnpm test:all` runs package tests plus the packed CLI e2e; it does not run the live Clerk tiers. [`pnpm test:clerk`](docs/DEVELOPMENT.md#live-clerk-pnpm-testclerk) runs the live Backend-API and Playwright tiers with development keys.

## Security

Report vulnerabilities privately by following the [security policy](SECURITY.md).

## License

All rights reserved for now — see [LICENSE](LICENSE). Outside contributions are not being accepted yet.
