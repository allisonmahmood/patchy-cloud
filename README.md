# Patchy Cloud

The private cloud where agents deploy apps.

Static-page publishing — grown from PatchPage — is the first thing it can deploy: an agent hands the server a single self-contained HTML file and gets back an unlisted URL. The rest of the cloud is being built.

## Relationship to PatchPage

[PatchPage](https://github.com/allisonmahmood/PatchPage) remains a separate, free product with its own repository and its own live instance. This repository is a full-history copy of it, taken in a different direction. It neither runs that service nor publishes anything to it: no shared release channel, no shared package name, no shared instance. See [ADR-0000](docs/adr/ADR-0000-origin-grown-from-patchpage.md).

## Repository layout

A Turborepo monorepo managed with pnpm.

- `apps/server` — the Effect HTTP server: wires the capability packages into one layer, guards `/api/*`, and listens (`@patchy/server`).
- `packages/cli` — `@patchy/cli`, the `patchy` command-line publisher.
- `packages/core` — shared HTML validation, hashing, and ID helpers (`@patchy/core`).
- `packages/api` — the wire contract: schemas, the `HttpApi`, the derived client (`@patchy/api`).
- `packages/auth` — tokens, principals, self-service minting, revocation, and the `auth` API group (`@patchy/auth`).
- `packages/patches` — patches and versions, the upload contract, retention and the expiry sweep, moderation, and the `patches` API group (`@patchy/patches`).
- `packages/serving` — the serving guarantees, the page routes, and the trusted-proxy schema (`@patchy/serving`).
- `packages/content-store` — the object store for a patch's bytes, with filesystem and Azure Blob layers (`@patchy/content-store`).
- `packages/sql`, `packages/analytics`, `packages/limits` — the Postgres client and Migrator, the event service, the rate limiter.
- `skills/patchy` — the agent skill that teaches an assistant to produce safe static HTML and publish it.
- `examples/plan.html` — a Patchy-styled starter draft.

## Local development

`pnpm dev` runs a complete local instance for the worktree you are in — embedded Postgres, migrations, a seeded company with a working token, and the server — and returns once it is healthy:

```sh
pnpm install && pnpm dev
```

Every upload requires a bearer token, on every configuration — there is no tokenless upload path. The runner writes the local one to `.local/dev/env`; source it and the CLI is pointed at the instance:

```sh
pnpm --filter @patchy/cli build &&
(
  set -eu
  set -a; . .local/dev/env; set +a
  PATCHY_STATE_DIR='.local/cli' node packages/cli/dist/index.js whoami &&
    PATCHY_STATE_DIR='.local/cli' node packages/cli/dist/index.js validate examples/plan.html &&
    PATCHY_STATE_DIR='.local/cli' node packages/cli/dist/index.js upload examples/plan.html
)
```

`pnpm dev status`, `stop`, `logs` and `reset` manage the instance; see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Put `packages/cli/dist/index.js` on your `PATH` as `patchy` and the same commands run as `patchy whoami`, `patchy validate`, `patchy upload`. The CLI defaults to `http://localhost:3000`; `--api-url` or `PATCHY_API_URL` points it at another instance. Full command and flag reference: [packages/cli/README.md](packages/cli/README.md).

Run all locally supported test suites with `pnpm test:all`; CI-only suites are reported as skipped with the reason. Other commands: `pnpm test`, `pnpm typecheck`, `pnpm build`.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the dev runner, running the server by hand, and storage notes. Patchy Cloud is the only deployment; there is no guide to running an instance of your own.

**Unlisted, not private.** Draft viewer URLs are long, unguessable, unlisted, and served `noindex` — but anyone with the link can open or reshare one. Don't publish secrets.

## Security

Report vulnerabilities privately by following the [security policy](SECURITY.md).

## License

All rights reserved for now — see [LICENSE](LICENSE).

Outside contributions are not being accepted yet.
