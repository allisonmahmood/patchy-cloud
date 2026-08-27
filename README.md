# Patchy Cloud

The private cloud where agents deploy apps.

Static-page publishing — grown from PatchPage — is the first thing it can deploy: an agent hands the server a single self-contained HTML file and gets back an unlisted URL. The rest of the cloud is being built.

## Relationship to PatchPage

[PatchPage](https://github.com/allisonmahmood/PatchPage) remains a separate, free product with its own repository and its own live instance. This repository is a full-history copy of it, taken in a different direction. It neither runs that service nor publishes anything to it: no shared release channel, no shared package name, no shared instance. See [ADR-0000](docs/adr/ADR-0000-origin-grown-from-patchpage.md).

## Repository layout

A Turborepo monorepo managed with pnpm.

- `apps/server` — Fastify HTTP server that validates uploads, stores drafts, and renders the sandboxed viewer (`@patchy/server`).
- `packages/cli` — `@patchy/cli`, the `patchy` command-line publisher.
- `packages/core` — shared HTML validation, hashing, and ID helpers (`@patchy/core`).
- `packages/db` — metadata store with Postgres and JSON-file drivers, plus schema migrations (`@patchy/db`).
- `packages/storage` — HTML object storage adapters: filesystem and Azure Blob (`@patchy/storage`).
- `packages/config` — environment-variable parsing and server configuration (`@patchy/config`).
- `skills/patchy` — the agent skill that teaches an assistant to produce safe static HTML and publish it.
- `examples/plan.html` — a Patchy-styled starter draft.

## Local development

The default local mode needs no Postgres: it uses a JSON metadata file and filesystem HTML storage.

```sh
pnpm install &&
  PATCHY_BOOTSTRAP_API_TOKEN=dev-token pnpm --filter @patchy/server dev
```

Every upload requires a bearer token, on every configuration — there is no tokenless upload path. In another shell, point the CLI at the local server with that bootstrap token:

```sh
pnpm --filter @patchy/cli build &&
(
  set +x
  set -eu
  PATCHY_API_URL='http://localhost:3000'
  export PATCHY_API_URL
  unset PATCHY_API_TOKEN
  PATCHY_SETUP_TOKEN='dev-token'
  ARTIFACT_PATH='examples/plan.html'

  printf '%s' "$PATCHY_SETUP_TOKEN" | PATCHY_STATE_DIR='.local/cli' node packages/cli/dist/index.js auth set --token-stdin --api-url "$PATCHY_API_URL"
  unset PATCHY_SETUP_TOKEN
  PATCHY_STATE_DIR='.local/cli' node packages/cli/dist/index.js whoami &&
    PATCHY_STATE_DIR='.local/cli' node packages/cli/dist/index.js validate "$ARTIFACT_PATH" &&
    PATCHY_STATE_DIR='.local/cli' node packages/cli/dist/index.js upload "$ARTIFACT_PATH"
)
```

Put `packages/cli/dist/index.js` on your `PATH` as `patchy` and the same commands run as `patchy whoami`, `patchy validate`, `patchy upload`. The CLI defaults to `http://localhost:3000`; `--api-url` or `PATCHY_API_URL` points it at another instance. Full command and flag reference: [packages/cli/README.md](packages/cli/README.md).

Run all locally supported test suites with `pnpm test:all`; CI-only suites are reported as skipped with the reason. Other commands: `pnpm test`, `pnpm typecheck`, `pnpm build`.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for Postgres mode and storage notes, and [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for running an instance, configuration, database migration, and minting tokens.

**Unlisted, not private.** Draft viewer URLs are long, unguessable, unlisted, and served `noindex` — but anyone with the link can open or reshare one. Don't publish secrets.

## Security

Report vulnerabilities privately by following the [security policy](SECURITY.md).

## License

All rights reserved for now — see [LICENSE](LICENSE).

Outside contributions are not being accepted yet.
