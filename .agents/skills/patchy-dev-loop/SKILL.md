---
name: patchy-dev-loop
description: Run a change against this worktree's local Patchy Cloud instance. Use when asked to check that a change works for real, to start or stop the dev instance, to drive the patchy CLI locally, or when a dev instance is reported unhealthy.
metadata:
  internal: "true"
---

# The dev loop

`pnpm dev` runs one complete Patchy Cloud per git worktree: embedded Postgres, migrations, and the shared `@patchy/auth/seed` — company Patchy Dev (`patchy-dev`), admin `dev@patchy.local` (Clerk id `user_dev`), and machine Dev Machine with token `patchy-dev-token` — then the server. Every command below is scoped to its worktree. Reference: `docs/DEVELOPMENT.md`.

When the change needs live Clerk integration checks, read
`docs/DEVELOPMENT.md`'s **Test tiers** first: `pnpm test:clerk` runs the
Backend-API and Playwright tiers, uses isolated databases, creates temporary
Clerk users and sends real invitation mail. It needs Chromium and its system
dependencies. `pnpm test` and the packed CLI e2e remain offline; `pnpm test:all`
does not include the live tiers.

## 1. Start

Use the Node and pnpm prerequisites in `docs/DEVELOPMENT.md` and run `pnpm install`
on a new checkout. Before startup, configure the required `CLERK_PUBLISHABLE_KEY`
and `CLERK_SECRET_KEY` in the developer-owned file
`$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env` by default).
An authenticated Clerk CLI can pull the development application's keys there:

```sh
clerk env pull --app app_3ImZuFeZJb8038U0oFds84rupA2 --file "${XDG_CONFIG_HOME:-$HOME/.config}/patchy-cloud/dev.env"
```

Dashboard key entry into the same private file also works. Keep secrets out of
terminal output, chat and git. The server's application environment is closed:
exported Clerk keys and other product settings do not reach it. The runner
supplies `DATABASE_URL` and `PATCHY_PUBLIC_BASE_URL` from its plan and logs only
the loaded Clerk setting names. Optional `CLERK_JWT_KEY` accepts a quoted
multiline RSA-2048 PEM for local token verification; browser sign-in still
needs Clerk. Leave `CLERK_AUTHORIZED_PARTIES` unset locally so per-port origins
do not evict sibling worktrees' sessions.

To use the person's existing Clerk development user as **Patchy Dev**'s admin,
set `PATCHY_DEV_CLERK_USER_ID` to that user's id in `dev.env` before the first
sign-in. It affects only the seed. Apply a changed value with
`pnpm dev stop && pnpm dev`, not a healthy instance's idempotent start.
See **Seed** in `docs/DEVELOPMENT.md` if that user already joined another company.

```sh
pnpm dev
```

Returns once `/healthz` answers and prints the plan: API URL, Postgres URL,
state dir and pids. Ports are derived from the worktree path and availability,
so use the URL in this output or `.local/dev/env`, not a copied port number.

Start is idempotent. A healthy instance is found and reprinted; a stopped one
starts with its data intact. Ports are selected again when starting, so always
use the returned URL. If the supervisor is alive but the server is unhealthy,
the runner refuses a concurrent start: retry while it starts or tears down,
or use `pnpm dev stop` before starting again.

Done when `pnpm dev status` exits 0.

## 2. Drive the CLI

For login/logout verification that must leave the developer's shared `~/.patchy`
state alone, first set `PATCHY_STATE_DIR="$PWD/.local/cli-check"` in the CLI's
environment. Use it for every command in the check, including completion.
Keep `PATCHY_API_TOKEN` unset: every command selects a key in this order,
environment token, stored credential for the instance, then the dev env's seed.
A saved login therefore overrides **Dev Machine**.

`pnpm patchy` runs from source without a build and discovers `.local/dev/env`
upward from the working directory. Leave `--api-url` out locally: that flag
bypasses discovery and its seed.

For a fresh publish as the person, have them open the printed API URL's `/join`
page in their browser and click **Sign in**. With the seed bound to their Clerk
user they reach **Patchy Dev** as admin; otherwise they create or join a company.
Then hand off the machine login:

```sh
pnpm patchy login --json
# Relay verificationUrl and userCode to the person; do not open their browser.
# They check the code, company and email, name the machine, and confirm.
pnpm patchy login --complete <userCode>
pnpm patchy whoami
pnpm patchy upload examples/plan.html --json
```

Use the returned `next` command through `pnpm patchy`, with the returned code.
Confirmation records approval; the poll mints and saves the user-owned machine
token without printing it. It lasts 90 days or 30 idle days unless revoked.
Completion names the person's company and `whoami` names their chosen machine.
Open the uploaded URL in that same signed-in browser.

`pnpm patchy login --complete --wait 0` polls once; an unanswered confirmation
reports `pending` at exit 0. Run `next` again after the person confirms. An agent
rerun of `login` resumes the pending code, rather than creating another handoff.
At a real human terminal without agent variables or `--json`,
`pnpm patchy login` waits in one command.

A seed-only CLI check can skip login: `pnpm patchy whoami` names **Dev Machine**
and uploads belong to the seeded admin. Its company pages can only be read by
a browser user in **Patchy Dev**; a different signed-in company gets 404.

The upload's `scope` determines who can open `publicUrl`; the field name does not promise anonymous access. New patches default to company scope. Uploading the same file again bumps the version of the same patch at the same URL and preserves scope unless `--share company` or `--share public` is given; if the CLI answers `Cached patch is unavailable for update`, the patch it remembers is gone from this instance (a `reset` does that) and `--new` creates a fresh one.
If the remembered patch belongs to a different user after switching from the
seed to a login, `--new` creates a patch owned by the current user; a login does
not transfer ownership of the earlier patch.

For `curl` against the API with the token, or for `DATABASE_URL`, export the env file in a separate shell: `set -a; . .local/dev/env; set +a`. Exporting the seed as `PATCHY_API_TOKEN` overrides a stored login; keep it unset for the login check. Logout cannot remove or revoke an environment key and warns about it.

## 3. Verify

Fetch the page and read what the server actually sent:

```sh
curl -i <publicUrl>
```

With no cookies, a company-scoped patch must answer **401** with the HTML
**Sign in** door, `x-patchy-sign-in-url`, and `Cache-Control: private, no-store`,
without `Location` or `WWW-Authenticate`. A machine token will not open it.
Read it through the user's browser, signed in to the same company as the
publishing identity. One sign-in returns to the patch; reload after 70 seconds
to exercise the shell's session refresh.

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

For a login change, verify the reverse after publishing and reading:

```sh
pnpm patchy logout
pnpm patchy whoami
```

Logout deletes the stored key and pending login before courtesy revocation,
says _This worktree's dev instance still publishes with its seeded key_, and
the final `whoami` names **Dev Machine** again. A courtesy-call failure is a
warning at exit 0; revoke the test key on **Your machines** if needed.
`/machines` also offers revoke-one, revoke-all and browser **Sign out**.
Browser sign-out ends the Clerk session, not the machine token.

When checking company management, `/join` offers **Not you? Sign out**, and
the deactivated page offers **Sign out** without a loop. `/company` sends real
invitation mail; use a `+clerk_test` address and revoke test invitations afterward.
Deactivation revokes machine tokens; reactivation restores browser access,
not the old keys.

The server has no per-request access log. Read `pnpm dev logs` for startup
failures and Clerk handshake diagnostics, without exposing credentials;
request-level status, headers and body come from the response itself.
One benign `relation "schema_migrations" does not exist` line is expected on
the first migration run.

Done when the response proves the behaviour you changed, and you have quoted it.

## 4. After a code change

The server is not watched. Every server or package change needs a restart:

```sh
pnpm dev stop && pnpm dev
```

Uploads and the database survive the restart.

`pnpm dev reset` wipes `.local/dev/` (every upload, the database, the log) and
starts fresh with the same seeded token, selecting available ports again.
Use it for disposable data when the three-baseline migration ledger changed
shape or the data is suspect. Earlier uploads are then missing: an active
signed-in reader gets 404, while a cookie-free fetch still gets the same 401
door. The CLI's state directory is separate and survives a dev reset.

## 5. Stop

```sh
pnpm dev stop
```

Stops this worktree's supervisor, server and Postgres, leaving `.local/dev/` on disk for the next start. Stop what you started when the task ends; an instance that was already running when you arrived belongs to whoever started it, so leave it up.

## Scripting against the runner

`--json` works on start, `status`, `reset` and `--dry-run`. Use `pnpm --silent dev ...` so pnpm's command echo does not precede the JSON. `status` exits 1 unless the instance is healthy. In the dry-run plan, `ports` is an object (`server`, `postgres`).
