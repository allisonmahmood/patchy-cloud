# Patchy Cloud Development

## The local instance: `pnpm dev`

`pnpm dev` runs a complete Patchy Cloud for the worktree you are in: an
embedded Postgres, migrations, a seeded dev company with a working token, and
the server. It returns as soon as `/healthz` answers and prints where
everything is:

```sh
pnpm install
pnpm dev
```

```
Patchy Cloud dev instance for /home/you/patchy-cloud
  API       http://127.0.0.1:29276  (PATCHY_API_TOKEN=patchy-dev-token)
  Postgres  postgresql://postgres:postgres@127.0.0.1:29277/patchy
  State     /home/you/patchy-cloud/.local/dev  (env, plan.json, dev.log)
  Pids      supervisor 80419, server 80457, postgres 80443
```

Starting is idempotent: a second `pnpm dev` finds the running instance and
prints the same plan. The processes outlive the shell that started them, so an
agent can start once and keep using the instance across turns.

Point the CLI at it by sourcing the env file the runner writes:

```sh
set -a; . .local/dev/env; set +a
patchy whoami
patchy upload examples/plan.html
```

### Subcommands

| Command                     | What it does                                                                      |
| --------------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`                  | Start (or confirm) this worktree's instance and print the plan.                   |
| `pnpm dev --dry-run --json` | Print the plan this worktree would run with, as JSON; touches nothing.            |
| `pnpm dev status`           | Which of the recorded processes are alive and whether `/healthz` answers.         |
| `pnpm dev stop`             | SIGTERM the recorded supervisor; Postgres and the server go with it. State stays. |
| `pnpm dev logs`             | Print `dev.log`.                                                                  |
| `pnpm dev reset`            | Stop, wipe `.local/dev/`, and start a fresh seeded instance.                      |

`--json` also works on `status`, `reset` and a plain start. The server is not
watched; after a code change, `pnpm dev stop && pnpm dev`.

### Per worktree

Every command is scoped to the git worktree containing the current directory.
Ports come from a hash of the worktree path (an even port in 20000–39998 for
the server, the next one for Postgres; the runner scans upward if the pair is
taken), so two worktrees run side by side and `stop` in one never touches the
other.

State lives in `<worktree>/.local/dev/` (gitignored):

- `plan.json` — the resolved plan, including the pids once running. `status`
  and `stop` act only on what is recorded here.
- `env` — `PATCHY_API_URL`, `PATCHY_API_TOKEN`, `DATABASE_URL`.
- `dev.log` — every line from every process, each prefixed `[dev]`,
  `[postgres]` or `[server]`.
- `postgres/` — the cluster's data directory; `storage/` — uploaded HTML.

### Seed

The instance is seeded with one company (`Patchy Dev`, `acct_dev`) and one
admin token (`patchy-dev-token`). The fixture is `scripts/dev/src/seed.ts`; the
vitest Postgres template (`test/postgres.ts`) applies the same rows, so tests
and the dev instance agree on what exists.

### How it works

`scripts/dev/` is the Effect 4 runner. `start` writes `plan.json` and spawns a
detached supervisor under `node --import tsx`; the supervisor owns one Effect
scope holding Postgres and the server, so either exiting — or `stop`'s
SIGTERM — tears the other down. Migrations run through Effect's Migrator in
`packages/sql`, behind `packages/db`'s `migrateDatabase` seam until the
migrations move into their capability packages.

## Running the server by hand

The runner is the normal path. The server can still be started directly, with
the filesystem-backed JSON store and no Postgres:

```sh
PATCHY_BOOTSTRAP_API_TOKEN=dev-token pnpm --filter @patchy/server dev
```

`pnpm seed:dev` uploads the accepted HTML fixture corpus to whatever
`PATCHY_API_URL`/`PATCHY_API_TOKEN` point at (default `http://localhost:3000`
with `dev-token`).

## Postgres Mode

Set `PATCHY_DB_DRIVER=postgres` and `DATABASE_URL` when a Postgres instance is
available. The server migrates the database on startup, before it listens.

Do not commit real database URLs or generated tokens.

## Azure Blob Storage

If you use Azure Blob storage, these are the variables:

```env
PATCHY_STORAGE_DRIVER=azure-blob
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=
```

The server uses managed identity when `AZURE_STORAGE_CONNECTION_STRING` is absent.
Connection-string auth remains available for local Azure testing and deployments that do not use Azure managed identity.
