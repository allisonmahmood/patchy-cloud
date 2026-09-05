---
name: patchy-dev-loop
description: Run a change against this worktree's local Patchy Cloud instance. Use when asked to check that a change works for real, to start or stop the dev instance, to drive the patchy CLI locally, or when a dev instance is reported unhealthy.
metadata:
  internal: "true"
---

# The dev loop

`pnpm dev` runs one complete Patchy Cloud per git worktree: embedded Postgres, migrations, and the shared `@patchy/auth/seed` — company Patchy Dev (`patchy-dev`), admin `dev@patchy.local` (Clerk id `user_dev`), and machine Dev Machine with token `patchy-dev-token` — then the server. Every command below is scoped to its worktree. Reference: `docs/DEVELOPMENT.md`.

To bind the seeded admin to your own Clerk development user, set
`PATCHY_DEV_CLERK_USER_ID=user_...` in the developer `dev.env` described below,
then restart the instance. Sign in at `/join` to land in Patchy Dev as admin;
without the override, a real sign-in lands on create-or-join. `/join` has
**Not you? Sign out**, returning to `/login`.

## 1. Start

```sh
pnpm dev
```

Returns in a few seconds once `/healthz` answers and prints the plan: API URL, Postgres URL, state dir, pids. Ports are hashed from the worktree path, so read the URL from this output or from `.local/dev/env`; the number is different in every worktree.

Start is idempotent. Run it whenever you are unsure: a running instance is found and reprinted, a stopped one (or one whose recorded pids are dead, which is what `pnpm dev status` shows after a crash or a reboot) is started on the same ports with its data intact. There is no case where you must `stop` before `start`.

Done when `pnpm dev status` exits 0.

The server's env is closed: shell exports never reach it. Load the required `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env` by default), one developer file for every worktree; `pnpm dev logs` names the loaded keys, not their values. The runner supplies required `DATABASE_URL` and `PATCHY_PUBLIC_BASE_URL` from its plan. Optional `CLERK_JWT_KEY` accepts a quoted multiline PEM for offline verification; leave `CLERK_AUTHORIZED_PARTIES` unset locally so per-port origins do not evict sibling worktrees' sessions. `PATCHY_DEV_CLERK_USER_ID` affects only the seed. Fix missing Clerk keys in the developer file, never in the repo:

```sh
clerk env pull --app app_3ImZuFeZJb8038U0oFds84rupA2 --file "${XDG_CONFIG_HOME:-$HOME/.config}/patchy-cloud/dev.env"
```

## 2. Drive the CLI

```sh
pnpm patchy whoami
pnpm patchy upload examples/plan.html --json
```

`pnpm patchy` runs the CLI from source; there is no build step. Run it from inside the worktree and it finds `.local/dev/env` on its own (it says `target came from .local/dev/env`). Passing `--api-url` switches that discovery off and the CLI then wants a stored token, so leave the flag out locally.

The upload's `publicUrl` is the page. Uploading the same file again bumps the version of the same patch at the same URL; if the CLI answers `Cached patch is unavailable for update`, the patch it remembers is gone from this instance (a `reset` does that) and `--new` creates a fresh one.

For `curl` against the API with the token, or for `DATABASE_URL`, export the env file: `set -a; . .local/dev/env; set +a`.

## 3. Verify

Fetch the page and read what the server actually sent:

```sh
curl -i <publicUrl>
```

The server logs nothing per request, so `pnpm dev logs` will not show a 401 or a 500; it answers "did it start, on which port". Filter it with `grep -E '\[(server|dev)\]'`, since most of the file is Postgres chatter, and expect one benign `relation "schema_migrations" does not exist` line on first run. Request-level evidence comes from the response itself.

Done when the response proves the behaviour you changed, and you have quoted it.

## 4. After a code change

The server is not watched. Every server or package change needs a restart:

```sh
pnpm dev stop && pnpm dev
```

About five seconds. Uploads and the database survive it.

`pnpm dev reset` is different: it wipes `.local/dev/` (every upload, the database, the log) and starts fresh on the same ports with the same seeded token. Reach for it when the migration ledger changed shape or the data is suspect, and expect earlier uploads to 404 afterwards.

## 5. Stop

```sh
pnpm dev stop
```

Stops this worktree's supervisor, server and Postgres, leaving `.local/dev/` on disk for the next start. Stop what you started when the task ends; an instance that was already running when you arrived belongs to whoever started it, so leave it up.

## Scripting against the runner

`--json` works on start, `status`, `reset` and `--dry-run`. Use `pnpm --silent dev ...` so pnpm's command echo does not precede the JSON. `status` exits 1 unless the instance is healthy. In the dry-run plan, `ports` is an object (`server`, `postgres`).
