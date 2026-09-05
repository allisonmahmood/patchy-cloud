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
then restart the instance. Sign in at `/join` to land on `/company` in Patchy
Dev as admin; without the override, a real sign-in lands on create-or-join.
Before joining, `/join` has **Not you? Sign out**, returning to `/login`.
Invites from `/company` send real mail through the developer's Clerk application;
use a `+clerk_test` address for live verification and revoke test invites afterward.

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

`pnpm patchy` runs the CLI from source; there is no build step. Run it from inside the worktree and it finds `.local/dev/env` on its own (it says `target came from .local/dev/env`). Passing `--api-url` switches that discovery off, so leave the flag out locally. Every command selects a key in the same order: `PATCHY_API_TOKEN`, a stored credential for this instance, then the dev env's seed. A saved login therefore overrides **Dev Machine**.

For a change to machine login, exercise the handoff and its reverse:

```sh
pnpm patchy login --json
# Show verificationUrl and userCode to the person; never open their browser.
pnpm patchy login --complete --wait 0
# pending is exit 0. After the person confirms, run the returned next:
pnpm patchy login --complete <userCode>
pnpm patchy whoami
pnpm patchy logout
pnpm patchy whoami
```

Use the returned code. With the seed bound to the person's Clerk user, completion
names **Patchy Dev** and `whoami` names the machine they chose. Logout deletes the
stored key and pending login before courtesy revocation, says _This worktree's
dev instance still publishes with its seeded key_, and the final `whoami` names
**Dev Machine** again. A courtesy-call failure is a warning at exit 0. At a real
terminal with no agent variables and no `--json`, `pnpm patchy login` waits in one
command; an agent uses the handoff and `next`.

The upload's `scope` determines who can open `publicUrl`; the field name does not promise anonymous access. New patches default to company scope. Uploading the same file again bumps the version of the same patch at the same URL and preserves scope unless `--share company` or `--share public` is given; if the CLI answers `Cached patch is unavailable for update`, the patch it remembers is gone from this instance (a `reset` does that) and `--new` creates a fresh one.

For `curl` against the API with the token, or for `DATABASE_URL`, export the env file in a separate shell: `set -a; . .local/dev/env; set +a`. Exporting the seed as `PATCHY_API_TOKEN` overrides a stored login; keep it unset for the login check. Logout cannot remove or revoke an environment key and warns about it.

## 3. Verify

Fetch the page and read what the server actually sent:

```sh
curl -i <publicUrl>
```

With no cookies, a company-scoped patch must answer **401** with the HTML
**Sign in** door, `x-patchy-sign-in-url`, and `Cache-Control: private, no-store`,
without `Location` or `WWW-Authenticate`. A machine token will not open it.
Open it through the user's browser; bind the seeded admin to their Clerk user
as above so they are in the patch's company. One sign-in returns to the patch;
reload after 70 seconds to exercise the shell's session refresh.

Exercise both sharing transitions through the CLI:

```sh
pnpm patchy upload examples/plan.html --share public --json
# Fetch publicUrl and publicUrl/v/<versionNumber> without cookies.
pnpm patchy share examples/plan.html company --json
# Fetch both again: 401, Cache-Control: private, no-store.
pnpm patchy share examples/plan.html public --json
# Fetch both again: 200, Cache-Control: public, max-age=60.
pnpm patchy share --patch <patchId> company --json
```

Use the returned id for `<patchId>`; select either the cached file or the id,
never both. Only the owner may change sharing. Upload and share report `scope`
in JSON; text output names who can open the link. While public, both URL shapes
must answer 200 with `Cache-Control: public, max-age=60`, no `Set-Cookie` and the
unchanged script-free CSP. The company transition must restore cookie-free 401
with `private, no-store` at both shapes. Public caches can keep their copy for
up to 60 seconds; downloaded copies cannot be recalled. Only public patches fetch
by URL; company pages are read through the user's signed-in browser.

A signed-in foreign-company reader and a missing patch must get the same private,
uncached 404; unenrolled readers go to `/join` with the patch as `return`, and
deactivated readers get 403. The packed CLI e2e covers the default-company 401,
the explicit public upload's viewer guarantees, and the return to company.
Production-domain Clerk handshake verification remains a separate live check.

The server logs nothing per request, so `pnpm dev logs` will not show a 401 or a 500; it answers "did it start, on which port". Filter it with `grep -E '\[(server|dev)\]'`, since most of the file is Postgres chatter, and expect one benign `relation "schema_migrations" does not exist` line on first run. Request-level evidence comes from the response itself.

Done when the response proves the behaviour you changed, and you have quoted it.

## 4. After a code change

The server is not watched. Every server or package change needs a restart:

```sh
pnpm dev stop && pnpm dev
```

About five seconds. Uploads and the database survive it.

`pnpm dev reset` is different: it wipes `.local/dev/` (every upload, the database, the log) and starts fresh on the same ports with the same seeded token. Reach for it when the migration ledger changed shape or the data is suspect. Earlier uploads are then missing: an active signed-in reader gets 404, while a cookie-free fetch still gets the indistinguishable 401 door.

## 5. Stop

```sh
pnpm dev stop
```

Stops this worktree's supervisor, server and Postgres, leaving `.local/dev/` on disk for the next start. Stop what you started when the task ends; an instance that was already running when you arrived belongs to whoever started it, so leave it up.

## Scripting against the runner

`--json` works on start, `status`, `reset` and `--dry-run`. Use `pnpm --silent dev ...` so pnpm's command echo does not precede the JSON. `status` exits 1 unless the instance is healthy. In the dry-run plan, `ports` is an object (`server`, `postgres`).
