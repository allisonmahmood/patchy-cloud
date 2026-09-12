# Patchy Cloud

A cloud for a company's internal tools, built for the agentic era.

People at a company build **patches** — anything from a static page to a full CRM — and deploy them here. Anyone can build one: a person who codes, or a person whose agent codes for them. Agents are good at CLIs and at running code locally, so the CLI is the front door: tell your agent to publish, and the patch is up. Log in once and reach everything in your company you have access to.

A patch runs at one of a few **tiers**: tier 0 is a static page with no patch code running anywhere, tier 1 runs in the viewer's browser, and tier 2 will add a hosted runtime. Patches use their own tables and files and reach company connections through Patchy, never through credentials of their own. Postgres is the first integration; Google Workspace and Salesforce are future integrations. [docs/product.md](docs/product.md) is the product's shape.

## Where it is today

Tier 0 static pages and tier 1 sandboxed browser tools. `patchy publish <file>` publishes one safe HTML file; `patchy init` starts a repo with config builders, a typed client and project skills. `patchy dev` exercises the real handlers locally over PGlite and invented fixtures; repo publishing typechecks and builds one self-contained HTML bundle. New starts and publishes require the current package release; deployed bundles keep their stable wire contract.

Patches have names at `/<company>/<patch>`, belong to users, and are shared with the company by default or made public on purpose. Tier 1 code acts as the viewer through the shell broker, never holding their login. It can read and write its own tables and files and read declared shared tables; company-data operations are unavailable on public tier 1 patches, even to members. Publish provisions resources additively in a Postgres database per company, preserving omitted definitions and data.

`patchy login` hands the person a browser URL and code; confirmation lets the CLI mint and save a user-owned machine token. Clerk holds the browser session. **Your machines** lists and revokes keys and offers browser sign-out; the company page handles invites, roles, deactivation and reactivation. Admins manage Postgres connections, encrypted credentials, immutable schema snapshots and recent calls at `/company/connections`. Patches get generated clients for constrained read-only queries; every integration call and table/file mutation is logged. Tiers 2 and above remain future work.

This repository is a full-history copy of [PatchPage](https://github.com/allisonmahmood/PatchPage), taken in a different direction. PatchPage remains a separate, free product with its own instance; nothing here runs it or publishes to it, and commits from before the split describe PatchPage, not Patchy Cloud.

## Try it

Use Node 22.18+ and the pnpm version in `package.json`. Before starting, load your **Clerk development keys** into the developer-owned `dev.env` as described in [Development: Clerk keys](docs/DEVELOPMENT.md#clerk-keys); shell exports alone do not configure the dev server.

```sh
pnpm install
pnpm dev
```

The runner starts embedded Postgres, applies all capability migrations, seeds **Patchy Dev** and its admin's development machine token, and prints this worktree's API URL. In your browser, open that URL's `/join` page and click **Sign in**. Create or join a company when prompted. To use **Patchy Dev** as its admin instead, set the optional [`PATCHY_DEV_CLERK_USER_ID`](docs/DEVELOPMENT.md#seed) before starting.

Keep `PATCHY_API_TOKEN` unset so a saved login outranks the development seed, then log in the CLI:

```sh
pnpm patchy login
```

Open the printed verification URL in your signed-in browser, check the code, company and email, name the machine, and confirm. At a human terminal the command waits and saves the key. An agent runs `pnpm patchy login --json`, relays `verificationUrl` and `userCode` to the person, and after confirmation runs the returned `next` command through `pnpm patchy login --complete <userCode>`. The CLI never opens the browser or prints the key.

Once login reports success:

```sh
pnpm patchy whoami
pnpm patchy publish examples/plan.html
```

Open the returned URL in the same signed-in browser. **Company scope is the default:** colleagues in that company can read the page, but a publishing key cannot open it. An agent reads company patches through its user's browser; only the current public tier 0 page can be read directly by URL. Tier 1 needs a browser to read its rendered frame. Choose `--share public` only when the page is intended for anyone holding the link. Don't publish secrets.

`pnpm patchy` runs from source and discovers this worktree's instance automatically. `pnpm dev stop` shuts it down. The complete runner and login recipes are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and the CLI's commands and contract are in [packages/patchy/README.md](packages/patchy/README.md).

To start a patch repo against this worktree, run `pnpm patchy init .local/team-tool --purpose "Track our team's work"`.
Initialization installs the pinned package and generates the client, context and project skills.
Inside that repo use `pnpm patchy catalog`, `add`, `remove` and `refresh`; see the
[project commands](packages/patchy/README.md#patch-repo-commands) for their contracts.
The repo is ready to typecheck, and hosted tier 1 patches use the sandboxed browser broker.
Run `pnpm patchy dev` to exercise it locally over PGlite and invented fixtures, then `pnpm patchy publish` from the repo root to build and publish it.

## Repository layout

A Turborepo monorepo managed with pnpm. [AGENTS.md](AGENTS.md) is the guide to working in it, for people and agents alike.

- `apps/server` — the Effect HTTP server: wires the capability packages into one layer, guards `/api/*`, and listens (`@patchy/server`).
- `packages/patchy` — `patchy`, one package for the CLI, config builders, browser client and local dev runtime; initializes patch repos, refreshes managed files and edits declarations.
- `packages/sdk` — current release and immutable tarball distribution, authenticated catalog and generation, and canonical project skills under `skills/` (`@patchy/sdk`).
- `packages/core` — shared HTML validation, hashing, ID helpers, and the first-party page shell (`@patchy/core`).
- `packages/api` — the wire contract: schemas, the `HttpApi`, the derived client (`@patchy/api`).
- `packages/companies` — companies, users, roles, invites and membership lifecycle (`@patchy/companies`).
- `packages/auth` — browser sessions, the shared login door, device login, machine tokens, Your machines, bearer identity, revocation, the shared development seed and the `auth` API group (`@patchy/auth`).
- `packages/patches` — user-owned patches and versions, names and addresses, replay-safe file/repo publishing, provisioning coordination, sharing, retention and the expiry sweep, owner-only deletion, and the `patches` API group (`@patchy/patches`).
- `packages/serving` — tier-scoped page/content routes, the login and needs-rebuild doors, sandboxed frame, shell broker and route bridge, sharing-aware CSP and caching, and trusted-proxy attribution (`@patchy/serving`).
- `packages/runtime` — browser-only admission, loaded-version binding, operation dispatch and the attributed runtime log (`@patchy/runtime`).
- `packages/primitives` — additive table/store provisioning, schema revisions, bounded owned-table operations, read-only shared-table operations and immutable file operations over Postgres and PGlite (`@patchy/primitives`).
- `packages/integrations` — company connection pages, encrypted credentials, Postgres discovery and immutable snapshots, constrained reads, generated relation clients, fixtures and publish declaration resolution (`@patchy/integrations`).
- `packages/content-store` — the object store for a patch's bytes, with filesystem and Azure Blob layers (`@patchy/content-store`).
- `packages/sql`, `packages/analytics`, `packages/limits` — the Postgres client and Migrator, the event service, the rate limiter.
- `packages/company-database` — company placements, lazy Postgres databases, bounded pools, transactional patch locks, cumulative inventory and the PGlite development layer.
- `skills/patchy` — the global agent skill for sign-in, safe static publishing, reading patches and starting a patch repo; project skills come from `packages/sdk`.
- `examples/plan.html` — a Patchy-styled starter patch.

`pnpm test`, `pnpm typecheck` and `pnpm lint` are the checks. `pnpm test:all` runs package tests, the real-Postgres concurrency suites and the packed CLI e2e; it does not run the live Clerk tiers. Install Chromium and its system dependencies first with `pnpm exec playwright install --with-deps chromium`. [`pnpm test:clerk`](docs/DEVELOPMENT.md#live-clerk-pnpm-testclerk) runs the live Backend-API and Playwright tiers with development keys.

## Security

Report vulnerabilities privately by following the [security policy](SECURITY.md).

## License

All rights reserved for now — see [LICENSE](LICENSE). Outside contributions are not being accepted yet.
