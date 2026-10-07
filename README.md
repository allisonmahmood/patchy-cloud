# Patchy Cloud

A cloud for a company's internal tools, built for the agentic era.

People at a company build **patches** — anything from a static page to a full CRM — and deploy them here. Anyone can build one: a person who codes, or a person whose agent codes for them. Agents are good at CLIs and at running code locally, so the CLI is the front door: tell your agent to publish, and the patch is up. Log in once and reach everything in your company you have access to.

A patch runs at one of three built tiers: tier 0 is a static page with no patch code, tier 1 runs in the viewer's browser, and tier 2 adds request-scoped server handlers. Patches use their own tables and files and reach company connections through Patchy, never through credentials of their own. Postgres is the first integration. [docs/product.md](docs/product.md) records the built contracts and pending work.

## Where it is today

Tier 0 static pages, tier 1 sandboxed browser tools and tier 2 hosted handlers are built. `patchy publish <file>` publishes one safe HTML file; `patchy init` starts a tier 1 repo with config builders, a typed client, Preact and project skills. Use `init --tier 2` for enforced rules, atomic multi-row writes or server-side work, not merely for live sync. `patchy dev` runs the hosted engine locally over PGlite and invented fixtures, with a second viewer URL on both scripted tiers. New starts and publishes require the current package release; deployed bundles keep their stable wire contract.

Tier 2 repos publish a second artifact, a closed server module. The instance
re-derives its handlers from stored bytes before recording the version.
Tier 2 is company-only. Its page calls generated server handlers rather than
name-based resources; a served tier 2 version closes older tier 1 tabs' direct
operations until reload or rollback.

The ECS fleet provider is built and passed role-only Fargate acceptance on
[#406](https://github.com/allisonmahmood/patchy-cloud/issues/406); production admission requires it.
The reference CRM journey and tier-picking check on
[#413](https://github.com/allisonmahmood/patchy-cloud/issues/413) run by hand after
the stack merges. Production infrastructure and its deploy workflow are written
([#415](https://github.com/allisonmahmood/patchy-cloud/issues/415)); the first
deploy, [#416](https://github.com/allisonmahmood/patchy-cloud/issues/416), has not happened.
Version revocation is unresolved on
[#425](https://github.com/allisonmahmood/patchy-cloud/issues/425): the `revoked`
frame exists, but no revocation operation does. Chromium desktop is the supported
browser. Tier 3, execution without a viewer, is next.

Patches have names at `/<company>/<patch>`, belong to users, and are shared with the company by default. Tiers 0 and 1 may be public; tier 2 cannot. Tier 1 code acts as the viewer through the shell broker, never holding their login. It can read and write its own tables and files and read declared shared tables and stores. The declared member directory admits signed-in company members on public tier 1 pages; other company-data operations remain unavailable there. Tier 2 callbacks act as the patch for its own resources and recheck the viewer for company data. Publish provisions resources additively in a Postgres database per company, preserving omitted definitions and data.

`patchy login` hands the person a browser URL and code; confirmation lets the CLI mint and save a user-owned machine token. Clerk holds the browser session. Your machines lists and revokes keys and offers browser sign-out; the company page handles invites, roles, deactivation and reactivation. Admins manage Postgres connections, encrypted credentials, immutable schema snapshots and recent calls at `/company/connections`. Patches get generated clients for constrained read-only queries; every integration call and table/file mutation is logged.

The signed-in `/` is the company's patch portal. Cards at `/patches/<name>` show descriptions, owners, sharing, versions and dependants, with management controls for owners and admins. Patches remain live or retired indefinitely; delete keeps them recoverable for 30 days. Owners can retire, delete, restore, roll back and describe through the CLI too. Admins can reassign patches and choose which to retire or restore when changing a user's active state; publish remains owner-only. Off addresses explain what happened and link colleagues to the card.

This repository is a full-history copy of [PatchPage](https://github.com/allisonmahmood/PatchPage), taken in a different direction. PatchPage remains a separate, free product with its own instance; nothing here runs it or publishes to it, and commits from before the split describe PatchPage, not Patchy Cloud.

## Try it

Use Node 22.22.0+ and the pnpm version in `package.json`. Nothing needs an account:

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts embedded Postgres, applies the migrations, seeds the **Patchy Dev** company and prints this worktree's URL. People sign in as dev personas: open `/dev/sign-in` and pick or type any email. The CLI runs from source and publishes as the seeded admin straight away:

```sh
pnpm patchy whoami
pnpm patchy publish examples/plan.html
```

Open the returned URL signed in as `dev@patchy.local`. **Company scope is the default:** colleagues in that company can read the page, but a publishing key cannot open it. Choose `--share public` only when the page is meant for anyone holding the link. Don't publish secrets.

For several people at once, `pnpm dev up` builds an environment from a scenario in `scenarios/`, with a logged-in CLI and an agent workspace; `pnpm dev up brightline` is the demo. `pnpm dev shot <person> <path>` captures a page as one person, and `pnpm dev down` removes everything. Work on Clerk sign-in uses `pnpm dev --clerk` with your Clerk development keys. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the full loop, and [packages/patchy/README.md](packages/patchy/README.md) the CLI's commands and contract.

To start a patch repo against this worktree, run `pnpm patchy init .local/team-tool --purpose "Track our team's work"`.
Initialization installs the pinned package and generates the client, context and project skills.
Use `pnpm patchy list` to find tools by description, `list <patch>` for their
tables and reads, and `list <patch> <table>` for keys and types. Discovery runs
anywhere under the saved login and never reads `patchy.json`; see the
[discovery contract](packages/patchy/README.md#discovery).
Inside the repo, `add`, `remove` and `refresh` manage declarations and generated
files; see the [project commands](packages/patchy/README.md#patch-repo-commands).
The repo is ready to typecheck, and hosted tier 1 patches use the sandboxed browser broker.
Run `pnpm patchy dev` to exercise it locally over PGlite and invented fixtures, then `pnpm patchy publish` from the repo root to build and publish it.

## Repository layout

A Turborepo monorepo managed with pnpm. [AGENTS.md](AGENTS.md) is the guide to working in it, for people and agents alike.

- `apps/server` — the Effect HTTP server: wires the capability packages into one layer, guards `/api/*`, and listens (`@patchy/server`).
- `apps/infra` — production infrastructure as AWS CDK: per environment, a base stack (image registry, deploy identity, budget, secrets) and an app stack (network, load balancer, hosts, exec task definition, uptime alert). CI synthesizes it offline, and releases apply it through the deploy workflow (`@patchy/infra`).
- `packages/patchy`: `patchy`, one package for the CLI, config builders, browser client and local dev runtime; initializes patch repos, refreshes managed files, edits declarations, discovers company tools and data sources, and manages owned patches.
- `packages/sdk` — current release and immutable tarball distribution, the front door's `/llms.txt` and `/install.mjs`, authenticated generation, and canonical project skills under `skills/` (`@patchy/sdk`).
- `packages/core`: shared HTML validation, the company look's publish checks (`@patchy/core/look`), hashing, ID helpers, and the first-party card shell, app shell and component set (`@patchy/core`).
- `packages/api` — the wire contract: schemas, the `HttpApi`, the derived client (`@patchy/api`).
- `packages/companies` — companies, users, roles, invites and membership lifecycle (`@patchy/companies`).
- `packages/auth` — browser sessions, the shared login door, device login, machine tokens, Your machines, bearer identity, revocation, the shared development seed and the `auth` API group (`@patchy/auth`).
- `packages/patches`: user-owned patches and versions, names and addresses, replay-safe file/repo publishing, provisioning coordination, sharing, lifecycle moves and actor stamps, visits and quotas, the deletion sweep, and the `patches` API group (`@patchy/patches`).
- `packages/portal`: the signed-in index and patch cards, versions, inline management, lifecycle and reassignment confirmations, user deactivation/reactivation pick pages, and owner/admin invocation logs with recent activity (`@patchy/portal`).
- `packages/serving`: tier-scoped page/content routes, address notices and login doors, the sandboxed frame, document-bound broker, route bridge, stream client, lifecycle notices, starting cover and trusted download action (`@patchy/serving`).
- `packages/runtime`: browser and invocation admission, capabilities and private callbacks, host-owned transactions, mutation keys, revisions and subscriptions, document streams, attribution and metering, and the admitted-work Executor port (`@patchy/runtime`).
- `packages/execution`: the credential-free workerd engine, isolated bundle inspection, process supervisor, private management listener, local executor and host fleet controller with local and ECS Fargate task providers (`@patchy/execution`). Shares Runtime's glossary.
- `packages/primitives`: additive table/store provisioning, resource revisions, bounded owned-table operations, read-only shared tables and stores, file handles, staged uploads and the declared member directory over Postgres and PGlite (`@patchy/primitives`).
- `packages/integrations`: company connection pages, encrypted credentials, Postgres discovery and immutable snapshots, the member-readable `connections` API group, constrained reads, generated relation clients, fixtures and publish declaration resolution (`@patchy/integrations`).
- `packages/content-store`: the object store for a patch's bytes, with filesystem and Neon Object Storage S3 layers (`@patchy/content-store`).
- `packages/sql`, `packages/analytics`, `packages/limits` — the Postgres client and Migrator, the event service, and the limits registry, company overrides and rate limiter.
- `packages/company-database` — company placements, lazy Postgres databases, bounded pools, transactional patch locks, cumulative inventory and the PGlite development layer.
- `skills/patchy` — the global agent skill for sign-in, safe static publishing, reading patches and starting a patch repo; project skills come from `packages/sdk`.
- `examples/plan.html` — a Patchy-styled starter patch.
- `scenarios/` — companies, people and patches that `pnpm dev up` builds local environments from (`scripts/dev`).

`pnpm check` runs format, lint, typecheck, the infrastructure synth and the offline tests. `pnpm verify` adds every acceptance suite CI runs except live Clerk; install Chromium first with `pnpm exec playwright install --with-deps chromium`. [`pnpm test:clerk`](docs/DEVELOPMENT.md#live-tiers) runs the live Clerk tiers with development keys.

## Security

Report vulnerabilities privately by following the [security policy](SECURITY.md).

## License

All rights reserved for now — see [LICENSE](LICENSE). Outside contributions are not being accepted yet.
