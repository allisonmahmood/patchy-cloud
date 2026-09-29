---
name: patchy-dev-loop
description: Run a change against this worktree's local Patchy Cloud instance. Use when asked to check that a change works for real, to start or stop the dev instance, to drive the patchy CLI locally, or when a dev instance is reported unhealthy.
metadata:
  internal: "true"
---

# The dev loop

`pnpm dev` runs one complete Patchy Cloud per git worktree: embedded Postgres,
migrations, a seeded **Patchy Dev** company and **Dev Machine** publishing key,
the packed `patchy` release, then the server. Every command below is scoped to its worktree.
Package-build failures appear under `[package]` in `dev.log`; a release check is
only meaningful when its reported tarball downloads with the reported integrity.
A shell broker that does not compile fails `pnpm dev` or `reset` on stderr before
anything is stopped or wiped; `stop`, `status` and `logs` still work.

When the change needs live Clerk integration checks, read
`docs/DEVELOPMENT.md`'s **Test tiers** first: `pnpm test:clerk` runs the
Backend-API and Playwright tiers, uses isolated databases, creates temporary
Clerk users and sends real invitation mail. It needs Chromium and its system
dependencies. `pnpm test` and the packed CLI e2e remain offline; `pnpm test:all`
does not include the live tiers.

## Execution supervisor checks

For `packages/execution` changes, use DEVELOPMENT's **The execution engine**
recipe. Exercise the isolated exec entrypoint and real workerd tests without
starting the cloud or touching Clerk. Prove that a killed generation cannot
forward callbacks and a fresh bind recovers without replay. Local execution
proves engine compatibility, not Fargate containment.

For fleet-controller changes, use DEVELOPMENT's **Exercising the fleet offline**
recipe on a disposable instance with `EXECUTION_PROVIDER=local-fleet`, its shared
task directory and stable callback addresses. Use independently constructed hosts
to verify routing, lease transfer and budget accounting. Cover stopping/adoption,
release/open races, slow starts, session loss, staged promotion and rollback.
Verify provider-stop metering and the database breaker. Exercise first-open and
resumed starting in the browser, including held calls across a stream drop and
refusal without replay on failure. Stop the disposable task resource explicitly;
host shutdown leaves shared tasks running. Keep the ordinary no-pool patch-repo
dev loop unchanged.

For tier 2 handler changes, follow DEVELOPMENT's **The execution engine**
guidance and exercise an eligible `server.call` through the existing `pnpm dev`
server composition. The local executor, private callback gateway, query snapshot
and mutation transaction adapters run there. For mutations, verify committed
replay with the same key, rollback after a handler failure, and parent-action
database time for a nested mutation. Use real Postgres for serialization,
cross-host key races and dropped-client connection cleanup; PGlite cannot prove
concurrent-session behavior. Publish a tier 2 repo to this local instance and
exercise its generated client in the hosted shell. Verify both artifact hashes,
`invalid_manifest` for bad descriptors, `tier2_not_public` on public sharing and
`server_required` in an older tier 1 tab, then rollback recovery. The patch-repo
`patchy dev` loop below runs the same supervised engine and callback gateway.

## Patch repos and the local runtime

For a patch repo against this checkout, follow DEVELOPMENT's **A patch repo
against this worktree** recipe. Initialize under `.local/` after the cloud is
healthy; this keeps instance discovery scoped here. `init` installs the release,
so run the pinned `pnpm patchy dev --json` without reinstalling.
Open its `url` and exercise the real generated client through the local shell:
insert/list, file upload/`url(name)`, and declared Postgres/shared fixtures as applicable.
For tiers 1 and 2, open `colleagueUrl` as the fixed non-admin colleague at a second
origin. Save through one viewer and observe the other's subscribed result without
reload. Tier 2 handlers use shared-table and Postgres fixtures through `ctx.shared`
and `ctx.connections`; fixture/config changes still need restart.
Done means the observed local result, not an ordinary Vite preview or a cloud read.

`patchy dev` is detached and idempotent; its `status`, `stop`, `logs` and `reset`
subcommands accept `--json`. Config and fixture edits require stop/start.
`src/` builds reload the whole shell; `server/` edits atomically rebind without
reload. Check unsaved browser state survives, in-flight nested calls retain the old
binding, and subscriptions wake on the new one while discarding crossing results.
Removed handlers or incompatible arguments permanently end affected subscriptions.
Add a module without restarting: the watcher discovers it and logs a reminder
to refresh types. A bad build must leave the last good binding serving.
Reset wipes disposable local state and leaves the runtime stopped; the next start
fetches the published inventory again. Missing fixtures name the file to author.
`dev.log` records viewer, handler, outcome, milliseconds, `ctx.log` and local-only
failure message/stack. Starting with `--json` records full wide events and
invocation JSON; `dev logs --json` remains `{ ok, log, text }`. No runtime database
log rows, PostHog delivery or connection keyring are used.

`patchy dev` runs the same handler engine and callback path as production.
It does not reproduce production's scheduling, limits or containment. A handler
that spins forever times out, and a health check restarts the dev engine, which
can interrupt other calls in flight. Contract limits still apply; production
operating capacity does not. Use real Postgres, not PGlite, to prove hosted
`busy` or `write_conflict` behavior. The `HandlerTls.test.ts` acceptance covers a
verify-full TLS connection and a non-superuser role through `ctx.connections`.

For worktree runtime edits, DEVELOPMENT gives the source-CLI invocation from inside
the patch repo. For a packed-release check, restart the cloud and follow DEVELOPMENT's
fresh repo **and isolated pnpm store/cache** recipe. A new repo alone can still
receive an older same-version tarball from the cache. After initialization, do
not reinstall as part of the agent's laid-down-tree exercise.
Stop every patch runtime you started before stopping the worktree's cloud instance.

## 1. Start

On a new checkout, follow the prerequisites and `pnpm install` in
[`docs/DEVELOPMENT.md`](../../../docs/DEVELOPMENT.md#the-local-instance-pnpm-dev).
Before startup, follow its [Clerk keys](../../../docs/DEVELOPMENT.md#clerk-keys)
recipe for the required developer-owned configuration; that section also owns
optional JWT verification and local authorized-party settings.
The runner creates the connection keyring in this worktree's `.local/dev/dev.env`
and retains it across restarts. Follow DEVELOPMENT's **Connection credential
keyring** section for rotation and connection checks; keep the file private and
never print its values. It is separate from the shared Clerk configuration.

To bind the seeded **Patchy Dev** admin to the person's Clerk development user,
follow [Seed](../../../docs/DEVELOPMENT.md#seed) before their first sign-in.
Read it again before changing that binding on an existing instance: a healthy
idempotent start does not reseed or move an enrolled user between companies.
The seed also backfills missing patch names from titles in creation order; named
patches keep their addresses. The test Postgres template runs the same backfill.
The shared seed contains identity rows, not example patches. A fresh portal is
empty; optional HTML fixture publishing creates live patches with empty descriptions.
Follow DEVELOPMENT's **Portal and patch lifecycle** recipe to create and inspect
retired or deleted examples rather than assuming the seed supplies them.
The runner also supplies both company-database URLs from its embedded Postgres;
company databases are created only when resources need them. For placement,
pool-budget or PGlite changes, follow DEVELOPMENT's **How it works** section:
exercise real-Postgres concurrency and the PGlite inventory suite, not a browser
publish of a primitive-free page.
For runtime admission changes, follow DEVELOPMENT's **How it works** section:
use an offline browser session for company calls, not the dev machine token,
and exercise historical versions as well as the current public version.

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
Repo commands still honor `patchy.json.instance`: discovery or an effective
override naming another instance fails with `instance_mismatch` before HTTP.
Correct the override while retaining the binding. For local experiments,
initialize a separate repo against the worktree's instance.

For a fresh publish as the person, follow DEVELOPMENT's
[first-publish browser setup](../../../docs/DEVELOPMENT.md#the-local-instance-pnpm-dev),
then [Device login through the CLI](../../../docs/DEVELOPMENT.md#device-login-through-the-cli)
for the agent's JSON handoff, confirmation and completion commands.
Complete login even when the seed already makes `status` report `hasToken: true`.
Proceed only after `pnpm patchy whoami` names the person's chosen machine, user
and company; **Dev Machine** is the seed, not evidence of a personal login.

```sh
pnpm patchy publish examples/plan.html --json
```

Open the returned `address` (`/<company>/<name>`) in that same signed-in browser.

A seed-only CLI check can skip login: `pnpm patchy whoami` names **Dev Machine**
and publishes belong to the seeded admin. Its company pages can only be read by
a browser user in **Patchy Dev**; a different signed-in company gets 404.

New patches default to company scope; use the returned `scope` to interpret
`address` (`publicUrl` equals it). Before reusing a cached publish after a reset or identity switch,
read [Reading a published patch](../../../docs/DEVELOPMENT.md#reading-a-published-patch)
for when `--new` is needed. Login does not transfer ownership of a seed's patch.

For `curl` against the API with the token, or for `DATABASE_URL`, export the env file in a separate shell: `set -a; . .local/dev/env; set +a`. Exporting the seed as `PATCHY_API_TOKEN` overrides a stored login; keep it unset for the login check. Logout cannot remove or revoke an environment key and warns about it.

## 3. Verify

Fetch the page and read what the server actually sent:

```sh
curl -i <address>
```

With no cookies, a company-scoped patch must answer **401** with the HTML
**Sign in** door, `x-patchy-sign-in-url`, and `Cache-Control: private, no-store`,
without `Location` or `WWW-Authenticate`. A machine token will not open it.
Read it through the user's browser, signed in to the same company as the
publishing identity. One sign-in returns to the patch; reload after 70 seconds
to exercise the shell's session refresh.

For serving, access-control or sharing changes, follow
[Reading a published patch](../../../docs/DEVELOPMENT.md#reading-a-published-patch):
exercise both CLI sharing transitions and a new publish on a public patch. Check
that only the current version is public at its latest and version URLs and older
versions keep the company door. Check status, cache headers, cookies and CSP,
along with foreign-company, unenrolled and deactivated readers. Use that section's
expected responses, including the public-cache delay, rather than treating a successful publish as proof.
For publish recovery, keep the isolated `PATCHY_STATE_DIR` and original owning user:
a pending attempt is resent first after authenticating that owner, even if the file
or current release changed. Repo attempts live in `.patchy/publish/`, survive a
repo move, and preserve `patchy.json.instance` when applying the returned patch id.
The target guard runs before recovery: correct a mismatching override rather
than rebinding the repo. Replacement tokens for the original user work; account
switches are refused before sending saved content.
Follow [ADR-0004](../../../docs/adr/ADR-0004-cli-contract-for-agents.md) for atomic
selection and definitive-refusal clearing. Exercise concurrent callers and a
killed caller: recovery resends the winner, while a stale response must leave a
newer attempt intact. New attempts check the CLI against `GET /api/release`.
Production-domain Clerk handshake verification remains a separate live check.

For portal or lifecycle changes, follow DEVELOPMENT's
[Portal and patch lifecycle](../../../docs/DEVELOPMENT.md#portal-and-patch-lifecycle)
recipe. Check the index and card as the seeded company's browser user, then the
retired/deleted address notice, restore and shared-reader refusal/recovery.
The machine token exercises owner CLI verbs, not browser pages or admin acts.
The packed e2e covers that lifecycle with a real shared-table consumer and the
description pull-down; the real-Postgres suite covers the publish, retire,
reassign, sweep and restore races.

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

Read `pnpm dev logs` for runtime request events, startup failures and Clerk
handshake diagnostics, without exposing credentials. Runtime call and file-byte
routes emit one JSON event per request, including refusals; other routes have no
per-request access log. Request-level status, headers and body come from the
response itself.
One benign `relation "schema_migrations" does not exist` line is expected on
the first migration run.

Done when the response proves the behaviour you changed, and you have quoted it.

## 4. After a code change

The server is not watched. Every server or package change needs a restart:

```sh
pnpm dev stop && pnpm dev
```

Published content and the database survive the restart.

`pnpm dev reset` wipes `.local/dev/` (published content, the database, the log) and
starts fresh with the same seeded token, selecting available ports again.
Use it for disposable data when a baseline, including `0003_patches_baseline` or
`0006_runtime_baseline`, changes shape or the data is suspect. Earlier patches
are then missing and answer 404, with or without a browser session. Retained
company patches still give signed-out readers the login door. The CLI's state
directory is separate and survives a dev reset.

## 5. Stop

```sh
pnpm dev stop
```

Stops this worktree's supervisor, server and Postgres, leaving `.local/dev/` on disk for the next start. Stop what you started when the task ends; an instance that was already running when you arrived belongs to whoever started it, so leave it up.

## Scripting against the runner

`--json` works on start, `status`, `reset` and `--dry-run`. Use `pnpm --silent dev ...` so pnpm's command echo does not precede the JSON. `status` exits 1 unless the instance is healthy. In the dry-run plan, `ports` is an object (`server`, `postgres`).
