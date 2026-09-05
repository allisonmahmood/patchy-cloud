# Patchy Cloud Development

## The local instance: `pnpm dev`

Use Node 22.13+ and the pnpm version in `package.json`, with dependencies installed
by `pnpm install`. Embedded Postgres is included; no separately managed database
is needed for this loop.

`pnpm dev` runs a complete Patchy Cloud for the worktree you are in: embedded
Postgres, migrations, a seeded dev company with a user-owned machine token, and
the server. Before the first start, load the [Clerk development keys](#clerk-keys).
Browser sign-in needs a real user in that Clerk application and network access
to Clerk; the seeded machine token alone does not sign a browser in.
The runner returns as soon as `/healthz` answers and prints where everything is:

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
A live supervisor with an unhealthy server refuses a concurrent start: retry
while it starts or tears down, or use `pnpm dev stop` before starting again.

For the first publish as yourself:

1. Open the printed API URL's `/join` page in your browser and click **Sign in**.
   With [`PATCHY_DEV_CLERK_USER_ID`](#seed) set before startup, you land in
   **Patchy Dev** as its admin. Without it, create or join a company when prompted.
2. Keep `PATCHY_API_TOKEN` unset and run `pnpm patchy login`. In a human terminal
   it waits while you open its URL in that signed-in browser, check the code,
   company and email, name the machine and confirm. An agent uses the
   [nonblocking JSON handoff](#device-login-through-the-cli) instead.
3. After login succeeds, verify that `whoami` names your chosen machine, user
   and company before publishing. **Dev Machine** identifies the seed, not a
   completed personal login:

   ```sh
   pnpm patchy whoami
   pnpm patchy upload examples/plan.html
   ```

4. Open the returned URL in the same signed-in browser. The new patch belongs
   to the logged-in user and is shared with their company by default.

`pnpm patchy` runs the CLI from source. Inside the worktree it finds the runner's
env file by itself. Every command selects a key in this order:
`PATCHY_API_TOKEN`, a stored credential for this instance, then the dev seed.
You can publish as **Dev Machine** immediately without a login, but only a
browser user in **Patchy Dev** can open that company patch.
The [logout recipe](#device-login-through-the-cli) removes the saved credential,
so the seed applies again.

For isolated login or logout checks, set `PATCHY_STATE_DIR` before every CLI
command in that check, for example `export PATCHY_STATE_DIR="$PWD/.local/cli-check"`.
The default is shared `~/.patchy`, with credentials, pending logins and patch
caches keyed by instance; it is not inside `.local/dev/`. Isolation leaves
existing developer state untouched and is useful when an old cache format
would otherwise refuse an upload. Keep the same state directory through login,
completion, publishing and logout, then revoke the test key before removing it.

For anything else that needs the URL, token or database (`curl`, `psql`),
source the env file: `set -a; . .local/dev/env; set +a`.
Do this in a separate shell when checking login: exporting the seed as
`PATCHY_API_TOKEN` makes it override the login. Logout cannot remove or revoke
that environment token and warns about it.

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
instance you already have, including the three rewritten auth baselines. It
deletes the database and uploaded HTML; use it only for disposable dev data.

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

The server's application settings are closed: exported Clerk keys, database
URLs and storage settings in your shell do not reach it. Its Clerk development
keys, `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, come from one dotenv file
per developer, shared by every worktree and never in the repo:
`$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env` by default).
`dev.log` names which settings it loaded, never their values.
With an installed Clerk CLI authenticated to the **patchy-cloud** development
application, pull its keys into that file:

```sh
clerk env pull --app app_3ImZuFeZJb8038U0oFds84rupA2 --file "${XDG_CONFIG_HOME:-$HOME/.config}/patchy-cloud/dev.env"
```

Alternatively, copy the development application's publishable and secret keys
from its Clerk dashboard into the same file as `KEY=value` entries. Keep the
file private and keep secret values out of terminal output, chat and git.
Use development keys, not the dedicated CI application's keys.

Both Clerk keys are required at server startup. The runner supplies the other
two required variables, `DATABASE_URL` and `PATCHY_PUBLIC_BASE_URL`, from its
worktree plan; values for either in `dev.env` are ignored.

`CLERK_JWT_KEY` optionally supplies Clerk's PEM public key to avoid the JWKS
fetch during session-token verification. In `dev.env`, enclose the complete
multiline PEM in double quotes. Normal local sign-in needs no override; it
does not make browser sign-in, invitations or sign-out offline. For supported
key formats and boot-time validation, see
[`packages/auth/src/Session.ts`](../packages/auth/src/Session.ts).

`CLERK_AUTHORIZED_PARTIES` optionally restricts tokens to one origin. Leave it
unset locally: a port-specific origin makes worktrees evict each other's
sessions. The runner forwards these two optional Clerk settings, but no other
settings from `dev.env` reach the server.

### Seed

The shared `@patchy/auth/seed` entry exports `DEV_SEED` and `applyDevSeed`.
It creates company **Patchy Dev** (`cmp_dev`, handle `patchy-dev`), its admin
**Patchy Dev** (`usr_dev`, Clerk id `user_dev`, email `dev@patchy.local`), and
the admin's machine **Dev Machine** (`tok_dev`, token `patchy-dev-token`).
Only the token's hash is stored. Reapplying restores the dev user's admin role
and active state, clears the seeded machine token's revocation, and resets its
90-day lifetime and last-use timestamp. Machine tokens also stop working after
30 idle days.

Set `PATCHY_DEV_CLERK_USER_ID=user_...` in the same developer `dev.env` to bind
the seeded admin to your Clerk development user; find that user's id in the
same application's Clerk user record. Set it before the first sign-in if you
want that user to be the seeded admin. After changing it, run
`pnpm dev stop && pnpm dev`; an idempotent start of a healthy instance does not
reseed. Unset or empty keeps `user_dev`. Offline tests and packed CLI e2e use
the default; the live browser tier binds its isolated seed to its own
run-namespaced Clerk user. The override changes only the seed, not the server's
environment. It does not move an already-enrolled user between companies;
use a fresh disposable dev database when changing that setup.

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
Without one, `/join` leads to `/company`; `/login`'s sign-in link leads to `/machines`.

### Device login through the CLI

Sign in and join a company in the browser first, as in the first-publish recipe.
With `PATCHY_DEV_CLERK_USER_ID` bound as above, confirmation logs the machine in
to **Patchy Dev**; otherwise it logs in to the company you created or joined.
Keep `PATCHY_API_TOKEN` unset so the login, not an exported seed, drives commands:

```sh
pnpm patchy login --json
```

An agent shows the person the returned `verificationUrl` and `userCode`,
never opens a browser, then runs `next` through the source CLI:

```sh
pnpm patchy login --complete <userCode>
pnpm patchy whoami
```

The person opens the URL in their own browser, checks the code, company and
email, names the machine and confirms. Confirmation alone creates no key;
the CLI's successful poll saves it without printing it.
The receipt names the company and machine, and `whoami` names that machine and
the user, company and role. The user-owned token lasts 90 days or 30 idle days,
unless revoked sooner on **Your machines**.

`pnpm patchy login --complete --wait 0` polls once and answers `pending` at
exit 0 if confirmation has not happened. Completion normally waits up to a
minute, including in-flight responses; an unanswered request at the deadline
is exit 3, with the local login record kept for the same completion command.
Reuse `next` after a pending answer. An agent rerun of `login` polls a pending
code once and reports its status rather than another handoff. At a real terminal,
with the agent variables unset and no `--json`, `pnpm patchy login` prints the
handoff and waits in one command.

```sh
pnpm patchy logout
pnpm patchy whoami
```

Logout forgets the stored key and pending login before attempting revocation,
and remains exit 0 if the courtesy call cannot reach the instance. Inside this
worktree it prints the seeded-key line and `whoami` returns to **Dev Machine**.
Outside a worktree, with no environment key, `whoami` after logout is exit 1,
`Run: patchy login`. `/machines` lists live publishing keys and can revoke
one or all; **Sign out** there ends only the browser session, clears Clerk
cookies and returns to `/login`.

An unconfirmed login returns `pending`; polling too quickly returns `slow_down`.
Codes last ten minutes. Expired and denied answers are 410 and consume the
login, as does a successful poll. Starting is limited to five requests per
source address per minute by default
(`PATCHY_DEVICE_LOGIN_RATE_LIMIT_PER_MINUTE` on the server); confirm-page
lookups have a separate per-user limit.

Device-login JSON and confirmation forms are limited to 4096 bytes. A declared
oversized body returns 413; exceeding the limit while streaming closes the
connection before parsing or changing a login.

Confirm and Deny return their informational outcome page directly with HTTP 200
and `Cache-Control: private, no-store`. A later GET reads the current code:
pending shows the form, an answered code returns 410 already used, and a code
consumed by the terminal's poll returns 404 unknown.

### Reading a published patch

New uploads default to company scope, including the seeded admin's patches;
reuploads without `--share` preserve their scope. The response includes `scope`;
`publicUrl` is a view URL, not a promise of anonymous access. For a company patch,
a cookie-free `curl -i <publicUrl>` answers **401** with the same HTML door as `/login`, one
**Sign in** link, `x-patchy-sign-in-url`, and `Cache-Control: private, no-store`;
it has neither `Location` nor `WWW-Authenticate`. A machine token does not open
the page. The latest and `/v/<n>` URL shapes follow the same access and cache rules.
If you previously uploaded this file as a different user (for example as the
seed before creating your own company), its cached patch is still owned by
that user. Use `pnpm patchy upload examples/plan.html --new` to create your own
patch. After `pnpm dev reset`, `--new` also replaces a cache entry whose patch
no longer exists; a cached update otherwise fails without silently creating one.

Open a patch published by your logged-in user in the same browser, or bind the
seed to your Clerk user before publishing as **Dev Machine**. Click **Sign in**
if needed and return to the patch. Reload after 70 seconds: the company
shell's Clerk client keeps the session fresh, so it should reopen without
another sign-in. A person without a company is sent to `/join?return=…` first;
a deactivated user gets 403. A signed-in user of a different company and a
missing patch get identical private, uncached 404 responses.

Exercise sharing through the CLI, not by editing rows:

```sh
pnpm patchy upload examples/plan.html --share public --json
# Fetch the returned publicUrl, and publicUrl/v/<versionNumber>, with cookie-free curl -i.
pnpm patchy share examples/plan.html company --json
# Fetch both URLs again: 401, Cache-Control: private, no-store.
pnpm patchy share examples/plan.html public --json
# Both URLs serve publicly again.
pnpm patchy share --patch <patchId> company --json
# The id form takes the same patch back inside without uploading another version.
```

The file form uses its cached patch; `--patch` selects an id instead, exactly one
target. Only the owner may change sharing. Upload and share JSON report `scope`,
and text output announces who can open the link. While public, both latest and
version URLs answer **200** with `Cache-Control: public, max-age=60`, no
`Set-Cookie`, and the unchanged script-free public CSP. After the company transition,
both answer cookie-free requests with **401** and `Cache-Control: private, no-store`.
A public copy may remain fresh in a cache for up to 60 seconds; downloaded copies
cannot be recalled. Only public patches fetch directly by URL; use the user's
signed-in browser for company pages.
The company shell permits only the configured Clerk Frontend API host and
Patchy's external session initializer; the uploaded document's sandbox is unchanged.

### Company management

The company page lists users, roles, active/deactivated state and pending
invites. Admins invite, revoke, resend, change roles, deactivate and reactivate;
members read the same page without management actions. Both roles can **Sign out**
there. The last active admin cannot be demoted or deactivated.

**Inviting on a dev instance sends real email through your Clerk development
application.** Patchy keeps the invitation even if Clerk cannot send it; the
page reports the failure and offers resend. Resend also recovers when the previous
Clerk invitation was already revoked, including after a lost revoke response.
Offline tests use recording and failing `InviteMail` layers instead. Deactivation revokes all the
user's machine tokens; reactivation restores browser access, not old keys.

### Test tiers

`pnpm test` stays offline and needs no Clerk account or development keys.
`pnpm test:packed-cli-e2e` exercises an installed CLI against its own server;
`pnpm test:all` runs package tests through Turbo and that packed e2e, but not
the live Clerk tiers. CI runs offline Vitest on Node 22 and 24, and one packed
e2e on Node 22 in `cli-smoke`, separately from the eligible live job.

The runner, the vitest template and the packed CLI e2e apply the shared dev seed.
`Testing.layer()` clones the seeded template; package fixtures add rows on
top. SQL's migrator tests alone use its empty-database layer.

Session tests use `@patchy/auth/testing`: fake Clerk keys under `.invalid`, an
RSA fixture and a loopback-only fetch guard. The packed CLI e2e starts its
server with the same fake keys and PEM, never a real Clerk account. Its viewer
checks cover the default company's cookie-free 401 with `private, no-store`,
an explicit `--share public` upload's 200 with `public, max-age=60`, no
`Set-Cookie` and the locked CSP, and `share … company` returning it to the 401 door.
It also drives the login handoff through confirmation with an offline-signed
session, completion, saved-login precedence, logout and seed fallback.
The dev runner imports only the separate seed entry, so it never
installs that guard. The production-domain Clerk handshake is a separate live
verification, not part of these offline checks.
The `async-exit-hook` dependency patch preserves failure exit codes when embedded
Postgres shuts down; without it, a failed Vitest suite can exit successfully.

#### Live Clerk: `pnpm test:clerk`

Install Chromium and its system dependencies once, then run both tiers:

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:clerk
```

Runs the Backend-API tier (`vitest.clerk.config.ts`), then the browser tier
(`playwright.clerk.config.ts`), serially against your **patchy-cloud**
development application, not your running dev server. Vitest reuses the
isolated, migrated Postgres template. Playwright starts a separate migrated
Postgres and checkout server, binds the dev seed's admin to this run's browser
Clerk user, and publishes a company patch with the seeded machine token.
Neither tier touches `.local/dev/` or your development seed.
When neither Clerk key is in the environment, the command reads both from
the [developer `dev.env`](#clerk-keys), using the same loader as `pnpm dev`.
An explicit or partial pair never falls back to that file; both keys must be
nonempty. GitHub Actions never reads the developer file. Running either
live config directly requires both environment keys and fails before setup
if either is absent.

Each run prints its `CLERK_TEST_RUN_ID` (a UUID locally, run id plus attempt
in CI). It creates `ci-<run id>+clerk_test@example.com` through Clerk's
Backend API, creates a session and JWT, and sends the session cookie through
the real `RequireSession` on `/company`. No `CLERK_JWT_KEY` is provided to
the layer, even if set in your shell: verification uses Clerk's JWKS.
The in-memory Vitest tier defaults `CLERK_AUTHORIZED_PARTIES` to its request
origin, `http://127.0.0.1:3000`; a Backend-API token's absent/null `azp` is accepted.

The invitation test creates, lists, revokes and re-invites
`ci-<run id>-invite+clerk_test@example.com` through live `InviteMail`.
**These requests send real invitation mail** (`notify: true`); the
`example.com` bounce is expected, not a delivery assertion.

The browser specs use Chromium, real Account Portal sign-in behind a Clerk
Testing Token, and the `424242` test email code:

- **`login-door`** opens the company patch signed out and checks its 401 door.
  The seeded browser user signs in through the Account Portal and returns
  through Clerk's handshake to the rendered patch and company shell. Reloading
  after the session token expires keeps the user signed in. The workflow adds
  the actual token-expiry wait to its timeout rather than assuming a fixed
  token lifetime (CI's overall job timeout still applies). A second user,
  in a separate browser context, signs in, creates a company through
  create-or-join, and gets the same 404 for the seeded company's patch as for
  a missing patch.
- **`patchy-login`** reuses the seeded user's signed-in browser to confirm the
  packed CLI's `patchy login --json` handoff with a machine name. Completion
  reports `logged_in`, `whoami` names the machine, and revoking that machine
  on `/machines` makes the next `whoami` return 401.

Playwright uses one worker, no retries, and a shared worker sign-in for the
seeded user: only two serial sign-ins for a full run, including the outsider.
The browser users are `ci-<run id>-browser+clerk_test@example.com` and
`ci-<run id>-outsider+clerk_test@example.com`. Browser requests go through
the page rather than `context.request`, which withholds Secure cookies on
the loopback HTTP origin. The isolated browser server always reserves its
own ephemeral loopback port, holding it until spawn instead of using an
ambient `PATCHY_PUBLIC_BASE_URL`. It restricts `CLERK_AUTHORIZED_PARTIES` to
that origin and uses live Clerk verification, not an ambient `CLERK_JWT_KEY`.

Select a workflow with a visible browser:

```sh
pnpm test:clerk --browser login-door --headed
pnpm test:clerk --browser patchy-login --headed
```

`--browser` skips Vitest and forwards the remaining arguments to Playwright.
Without it, both tiers run serially and the first nonzero exit status is retained.
Vitest teardown and the runner's final cleanup delete all three exact
run-namespaced user addresses (ending their sessions), check zero users remain,
and revoke pending invitations for the exact invitation email. The runner
also sweeps on normal test failure and after SIGINT/SIGTERM. Revoked invitation
records remain in Clerk. CI installs Chromium and its system dependencies,
runs both tiers, and repeats the idempotent sweep in an `always()` step,
including when the test step fails or is cancelled. No sweep touches another
run's addresses. If a local process is forcibly killed before teardown,
repeat the printed run id:

```sh
CLERK_TEST_RUN_ID=<printed-run-id> pnpm test:clerk --cleanup
```

The dedicated CI application is **patchy-cloud-ci**, Frontend API
`super-whale-1225.clerk.accounts.dev`. Its keys live only in repository
secrets `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`, never in `dev.env`
or the repository. The `clerk-live` job runs on pushes to `main` and
same-repository PRs except Dependabot; forks and Dependabot skip it and run
the offline tier. An eligible run with a missing secret fails, never skips.
Both configs and the cleanup runner reject CI publishable keys unless they
identify exactly `super-whale-1225.clerk.accounts.dev`, before any Clerk request.
Marking `clerk-live` required in branch protection is a maintainer step;
a skipped job satisfies a required check.

### How it works

`scripts/dev/` is the Effect 4 runner. `start` writes `plan.json` and spawns a
detached supervisor under `node --import tsx`; the supervisor owns one Effect
scope holding Postgres and the server, so either exiting — or `stop`'s
SIGTERM — tears the other down. Migrations run through Effect's Migrator in
`packages/sql`: Companies owns `0001_companies_baseline`, Auth owns
`0002_auth_baseline`, and Patches owns `0003_patches_baseline`. The three
migrator spreads are `apps/server/src/Server.ts`,
`scripts/dev/src/supervisor.ts` and `test/postgres.ts`; server tests clone the
template without passing migrations. Packed and live browser servers migrate
through the server's existing spread rather than maintaining another one.

## Running the server by hand

The runner is the normal path. The server can still be started directly
against a Postgres you point it at:

Unlike `pnpm dev`, a hand-started server reads the environment you give it, not
the developer `dev.env`. Export `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`
securely first, then supply a disposable Postgres URL and the browser-facing
origin:

```sh
DATABASE_URL=postgres://... PATCHY_PUBLIC_BASE_URL=http://localhost:3000 \
  PATCHY_STORAGE_DIR=.local/manual-storage pnpm --filter @patchy/server dev
```

All four variables are required: `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY` and `PATCHY_PUBLIC_BASE_URL`. None has a default; startup
refuses a missing variable and names it. `PATCHY_PUBLIC_BASE_URL` must be an
HTTP(S) origin, without credentials, a path, query or fragment, and must match
the URL used in the browser; it is Clerk's single origin authority.
`PORT` defaults to 3000; set it and the public origin together if changing ports.
The optional Clerk settings have the same rules as [above](#clerk-keys).

Startup migrates but creates no credential. For normal use, sign in at `/join`,
create or join a company, then run `pnpm patchy login --api-url <origin>` and
publish with that same `--api-url`. The flag deliberately bypasses worktree
discovery, including its development seed.
For a seeded disposable database instead, apply `applyDevSeed(DATABASE_URL)`
from `@patchy/auth/seed` after migration, optionally passing your Clerk user id
as its second argument; use the development token through `PATCHY_API_TOKEN`.
The seed is for development only.

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

Without `AZURE_STORAGE_CONNECTION_STRING`, the server requires
`AZURE_STORAGE_ACCOUNT` and uses Azure's `DefaultAzureCredential` chain,
including managed identity in a configured deployment. Connection-string auth
remains available for local Azure testing and deployments without managed identity.
