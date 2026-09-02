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

`pnpm patchy` runs the CLI from source, and inside the worktree the CLI finds
the runner's env file by itself:

```sh
pnpm patchy whoami
pnpm patchy upload examples/plan.html
```

For anything else that needs the URL, token or database (`curl`, `psql`),
source the env file: `set -a; . .local/dev/env; set +a`.

### Subcommands

| Command                     | What it does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`                  | Start (or confirm) this worktree's instance and print the plan.                                  |
| `pnpm dev --dry-run --json` | Print the plan this worktree would run with, as JSON; touches nothing.                           |
| `pnpm dev status`           | Which of the recorded processes are alive and whether `/healthz` answers; exit 1 unless healthy. |
| `pnpm dev stop`             | SIGTERM the recorded supervisor; Postgres and the server go with it. State stays.                |
| `pnpm dev logs`             | Print `dev.log`.                                                                                 |
| `pnpm dev reset`            | Stop, wipe `.local/dev/`, and start a fresh seeded instance.                                     |

`reset` is also the answer when the migration ledger changes shape under an
instance you already have (as it did when migrations moved onto Effect's Migrator).

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
`packages/sql`: `packages/auth` and `packages/patches` each own theirs, and
the server, the runner and the vitest template each spread the two records
into one run.

## Running the server by hand

The runner is the normal path. The server can still be started directly
against a Postgres you point it at:

```sh
DATABASE_URL=postgres://... PATCHY_BOOTSTRAP_API_TOKEN=dev-token pnpm --filter @patchy/server dev
```

`pnpm seed:dev` uploads the accepted HTML fixture corpus to whatever
`PATCHY_API_URL`/`PATCHY_API_TOKEN` point at (default `http://localhost:3000`
with `dev-token`).

## Postgres

`DATABASE_URL` is required: Postgres is the only store. The server migrates
the database on startup, before it listens; the packed-CLI e2e starts an
embedded Postgres of its own under its temp root.

Do not commit real database URLs or generated tokens.

## Azure Blob Storage

The server writes a patch's bytes to Azure Blob whenever `AZURE_STORAGE_CONTAINER`
is set, and to `PATCHY_STORAGE_DIR` on local disk otherwise:

```env
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=
```

The server uses managed identity when `AZURE_STORAGE_CONNECTION_STRING` is absent.
Connection-string auth remains available for local Azure testing and deployments that do not use Azure managed identity.
