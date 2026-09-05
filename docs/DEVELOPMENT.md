# Patchy Cloud Development

## The local instance: `pnpm dev`

`pnpm dev` runs a complete Patchy Cloud for the worktree you are in: an
embedded Postgres, migrations, a seeded dev company with a working token, and
the server. Before the first start, load the [Clerk development keys](#clerk-keys).
It returns as soon as `/healthz` answers and prints where everything is:

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

### Clerk keys

The server's env is closed: nothing exported in your shell reaches it. Its Clerk
development keys, `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, come from one
dotenv file per developer, shared by every worktree and never in the repo:
`$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env` by default).
`dev.log` names which keys it loaded. The Clerk CLI writes the file:

```sh
clerk env pull --app app_3ImZuFeZJb8038U0oFds84rupA2 --file "${XDG_CONFIG_HOME:-$HOME/.config}/patchy-cloud/dev.env"
```

Both Clerk keys are required at server startup. The runner supplies the other
two required variables, `DATABASE_URL` and `PATCHY_PUBLIC_BASE_URL`, from its
worktree plan; values for either in `dev.env` are ignored.

`CLERK_JWT_KEY` is optional and primarily test-facing: a PEM public key makes
session verification offline by avoiding Clerk's JWKS fetch. The server
validates it at boot. If you need it in `dev.env`, enclose the complete
multiline PEM in double quotes; its line breaks are preserved. Normal local
sign-in uses your Clerk development keys without this override.

`CLERK_AUTHORIZED_PARTIES` optionally restricts tokens to one origin. Leave it
unset locally: a port-specific origin makes worktrees evict each other's
sessions. The runner forwards these two optional Clerk settings, but no other
settings from `dev.env` reach the server.

### Seed

The shared `@patchy/auth/seed` entry exports `DEV_SEED` and `applyDevSeed`.
It creates company **Patchy Dev** (`cmp_dev`, handle `patchy-dev`), its admin
**Patchy Dev** (`usr_dev`, Clerk id `user_dev`, email `dev@patchy.local`), and
the admin's machine **Dev Machine** (`tok_dev`, token `patchy-dev-token`).
Only the token's hash is stored. Reapplying restores the dev user's active
state and the machine's 90-day lifetime and last-use timestamp.

Set `PATCHY_DEV_CLERK_USER_ID=user_...` in the same developer `dev.env` to bind
the seeded admin to your Clerk development user. Restart `pnpm dev` to apply
it; unset or empty keeps `user_dev`. Tests and packed e2e always use the
default. The override changes only the seed, not the server's environment.

Open `/join` at the instance's API URL to sign in:

- Signed out, it answers 401 with a **Sign in** link to Clerk's Account Portal.
- With your `PATCHY_DEV_CLERK_USER_ID` bound to the seed, signing in lands on
  `/company` for **Patchy Dev** as its admin.
- Without the override, your real Clerk user lands on create-or-join. The page
  names your email and offers every live invitation for it, or a form to
  create a company with an editable handle. Creating makes you the admin;
  joining or creating lands on `/company`.
- **Not you? Sign out** on `/join` revokes the session, clears Clerk's cookies
  and returns to `/login`; the next `/join` is the signed-out door. A deactivated
  user sees a 403 page with **Sign out**, not a sign-in loop.

A validated `return` path sends a person who has a company back to that page.
Without one, `/join` and `/login`'s sign-in link lead to `/company`.

The company page lists users, roles, active/deactivated state and pending
invites. Admins invite, revoke, resend, change roles, deactivate and reactivate;
members read the same page without management actions. The last active admin
cannot be demoted or deactivated.

**Inviting on a dev instance sends real email through your Clerk development
application.** Patchy keeps the invitation even if Clerk cannot send it; the
page reports the failure and offers resend. Tests use recording and failing
`InviteMail` layers instead and stay offline. Deactivation revokes all the
user's machine tokens; reactivation restores browser access, not old keys.

The runner, the vitest template and the packed CLI e2e apply these same rows.
`Testing.layer()` clones the seeded template; package fixtures add rows on
top. SQL's migrator tests alone use its empty-database layer.

Session tests use `@patchy/auth/testing`: fake Clerk keys under `.invalid`, an
RSA fixture and a loopback-only fetch guard. The packed CLI e2e starts its
server with the same fake keys and PEM, never a real Clerk account. The dev
runner imports only the separate seed entry, so it never installs that guard.

### How it works

`scripts/dev/` is the Effect 4 runner. `start` writes `plan.json` and spawns a
detached supervisor under `node --import tsx`; the supervisor owns one Effect
scope holding Postgres and the server, so either exiting — or `stop`'s
SIGTERM — tears the other down. Migrations run through Effect's Migrator in
`packages/sql`: Companies, Auth and Patches own baselines 1, 2 and 3,
respectively. The server, runner and vitest template each spread those three
records into one run; server tests clone the template without migrations.

## Running the server by hand

The runner is the normal path. The server can still be started directly
against a Postgres you point it at:

```sh
DATABASE_URL=postgres://... PATCHY_PUBLIC_BASE_URL=http://localhost:3000 \
  CLERK_PUBLISHABLE_KEY=pk_test_... CLERK_SECRET_KEY=sk_test_... \
  PATCHY_STORAGE_DIR=.local/manual-storage pnpm --filter @patchy/server dev
```

All four variables are required: `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY` and `PATCHY_PUBLIC_BASE_URL`. None has a default; startup
refuses a missing variable and names it.
Startup migrates but creates no credential. Against a disposable local database,
apply `applyDevSeed(DATABASE_URL)` from `@patchy/auth/seed` after migration,
then use `PATCHY_API_TOKEN=patchy-dev-token`. The seed is for development only.

`pnpm seed:dev` uploads the accepted HTML fixture corpus. Both `PATCHY_API_URL`
and `PATCHY_API_TOKEN` are required; neither has a default.

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
