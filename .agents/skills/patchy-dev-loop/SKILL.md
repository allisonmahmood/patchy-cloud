---
name: patchy-dev-loop
description: Run a change against this worktree's local Patchy Cloud instance. Use when asked to check that a change works for real, to start or stop the dev instance, to drive the patchy CLI locally, or when a dev instance is reported unhealthy.
metadata:
  internal: "true"
---

# The dev loop

`pnpm dev` runs one complete Patchy Cloud per git worktree: embedded Postgres,
migrations, a seeded **Patchy Dev** company and **Dev Machine** publishing key,
then the server. Every command below is scoped to its worktree.

When the change needs live Clerk integration checks, read
`docs/DEVELOPMENT.md`'s **Test tiers** first: `pnpm test:clerk` runs the
Backend-API and Playwright tiers, uses isolated databases, creates temporary
Clerk users and sends real invitation mail. It needs Chromium and its system
dependencies. `pnpm test` and the packed CLI e2e remain offline; `pnpm test:all`
does not include the live tiers.

## 1. Start

On a new checkout, follow the prerequisites and `pnpm install` in
[`docs/DEVELOPMENT.md`](../../../docs/DEVELOPMENT.md#the-local-instance-pnpm-dev).
Before startup, follow its [Clerk keys](../../../docs/DEVELOPMENT.md#clerk-keys)
recipe for the required developer-owned configuration; that section also owns
optional JWT verification and local authorized-party settings.

To bind the seeded **Patchy Dev** admin to the person's Clerk development user,
follow [Seed](../../../docs/DEVELOPMENT.md#seed) before their first sign-in.
Read it again before changing that binding on an existing instance: a healthy
idempotent start does not reseed or move an enrolled user between companies.

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

For a fresh publish as the person, follow DEVELOPMENT's
[first-publish browser setup](../../../docs/DEVELOPMENT.md#the-local-instance-pnpm-dev),
then [Device login through the CLI](../../../docs/DEVELOPMENT.md#device-login-through-the-cli)
for the agent's JSON handoff, confirmation and completion commands.
Complete login even when the seed already makes `status` report `hasToken: true`.
Proceed only after `pnpm patchy whoami` names the person's chosen machine, user
and company; **Dev Machine** is the seed, not evidence of a personal login.

```sh
pnpm patchy upload examples/plan.html --json
```

Open the uploaded URL in that same signed-in browser.

A seed-only CLI check can skip login: `pnpm patchy whoami` names **Dev Machine**
and uploads belong to the seeded admin. Its company pages can only be read by
a browser user in **Patchy Dev**; a different signed-in company gets 404.

New patches default to company scope; use the returned `scope` to interpret
`publicUrl`. Before reusing a cached upload after a reset or identity switch,
read [Reading a published patch](../../../docs/DEVELOPMENT.md#reading-a-published-patch)
for when `--new` is needed. Login does not transfer ownership of a seed's patch.

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

For serving, access-control or sharing changes, follow
[Reading a published patch](../../../docs/DEVELOPMENT.md#reading-a-published-patch):
exercise both CLI sharing transitions at the latest and version URLs, checking
status, cache headers, cookies and CSP; also check foreign-company, unenrolled
and deactivated readers. Use that section's expected responses, including the
public-cache delay, rather than treating a successful upload as proof.
Production-domain Clerk handshake verification remains a separate live check.

For a login change, follow the logout check in
[Device login through the CLI](../../../docs/DEVELOPMENT.md#device-login-through-the-cli)
after publishing and reading. Confirm the stored login is gone and `whoami`
returns to **Dev Machine**; revoke the test machine on `/machines` if courtesy
revocation failed. Browser sign-out is a separate check from machine logout.

For company-management changes, read
[Company management](../../../docs/DEVELOPMENT.md#company-management) and
[Seed](../../../docs/DEVELOPMENT.md#seed) for the management and sign-out checks.
Invitations send real mail: use a `+clerk_test` address and revoke test
invitations afterward.

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
