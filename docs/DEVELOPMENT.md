# Patchy Cloud Development

Pull, change, check, see it work, ship. Everything here runs offline against
this worktree; nothing needs an account. Running the server outside `pnpm dev`,
the execution fleet and the spike deploy live in [Operations](OPERATIONS.md).

## Setup

Use Node 22.22.0+ (`mise.toml` pins 24) and the pnpm version in `package.json`:

```sh
pnpm install
pnpm exec playwright install --with-deps chromium   # browser and packed suites
```

Install pins `workerd` and embedded Postgres per platform; nothing is installed
globally. In T3 Code, `t3.json` runs the install for each new worktree and
offers start, stop, environment and **Check** actions; import them once from
**From t3.json** in the project actions menu.

## Checks

| Command                 | Runs                                                                                       | When                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `pnpm check`            | format, lint, typecheck (tests included), the infrastructure synth and the offline tests   | while working; a few minutes          |
| `pnpm verify`           | `check`, then every acceptance suite CI runs except live Clerk                             | before calling a change ready to ship |
| `pnpm verify --changed` | the same, skipping the acceptance suites when only docs, agent files or the runner changed | docs and runner changes               |

`pnpm verify` mirrors CI's jobs: `postgres-concurrency`, `cli-smoke` (a
one-second check that the packed harness reaps orphaned processes, the packed CLI
end to end, and the packed Preact runtime), `tier2-smoke` (the packed tier 2
journey) and `browser` (tier 1 and 2 pages in Chromium). It keeps
going after a failure and prints a summary. CI also runs `pnpm test` on Node
22.22.0, 24 and 26, `cli-smoke` again on Node 26, and `clerk-live` on pushes to
`main` and same-repository PRs.

Format and lint cache their results, so a repeat run rechecks only the files
that changed. ESLint's cache cannot tell when a changed type alters an unchanged
file's result, so `pnpm verify` lints from scratch, as CI does.

For a focused loop:

- `pnpm exec vitest run <files or folders>`; `*.postgres.test.ts` files need
  `--config vitest.postgres.config.ts`.
- `pnpm typecheck:tests` checks every test and harness file in one program,
  about three seconds when warm. Package `src` is checked by `pnpm typecheck`.
- `pnpm exec playwright test -c playwright.tier1.config.ts --project=chromium <spec>`
  runs one browser spec.

Every vitest run builds the shell broker and stages the packed CLI release once
before its workers start. The release build reuses its last output when nothing
it reads changed (`PATCHY_PACKAGE_REBUILD=1` forces it), so a single test file
takes seconds.

### Writing tests

- Tests are offline. A fetch guard fails any suite that reached the network,
  even when the code caught the error.
- A package with tests has a `vitest.config.ts` re-exporting `test/`'s config.
  Without one, `pnpm --filter <pkg> test` runs with no Postgres and no guard.
- Cases that launch processes or boot PGlite get a 30-second budget scoped to
  them; pure cases keep vitest's five seconds.
- PGlite has one connection, so locking, contention and cancellation need real
  Postgres: put those in `*.postgres.test.ts`, which `pnpm test:postgres-concurrency` runs.
- Each Playwright worker in the tier 1 browser suite runs one Postgres cluster, and
  every test gets a fresh `patchy` database cloned from a template that the worker
  migrated and seeded once. Teardown drops that database and every company database
  it placed. If a database, role, role setting or connection outlives its test, the
  next test fails, so a spec closes any client it opens itself.
- `tsconfig.test.json` keeps Effect's correctness rules and turns off the style
  rules that steer production code toward Effect services.
- A test that fails with no code cause is flaky. Check open issues labelled
  `flaky` before treating a red check as yours; open one for a new flake with the
  failing run, and fix the cause rather than adding retries.

### Live tiers

`pnpm test:clerk` runs the Backend-API and Playwright tiers against your Clerk
development application. They create run-scoped Clerk users and **send real
invitation mail**; teardown deletes the users. `--browser <spec> --headed` runs
one browser spec visibly, and `CLERK_TEST_RUN_ID=<printed id> pnpm test:clerk --cleanup`
sweeps a killed run. Keys come from [your `dev.env`](#clerk-keys); CI uses the
**patchy-cloud-ci** application's keys from repository secrets only. The live
content store suite needs Neon credentials; see
[Operations](OPERATIONS.md#the-live-content-store-suite).

## The local instance: `pnpm dev`

`pnpm dev` runs a complete Patchy Cloud for this worktree: embedded Postgres,
migrations, the seeded **Patchy Dev** company, the packed `patchy` release and
the server. It returns when `/healthz` answers and prints the plan:

```
Patchy Cloud dev instance for /home/you/patchy-cloud
  API       http://127.0.0.1:29276  (PATCHY_API_TOKEN=patchy-dev-token)
  Sign in   http://127.0.0.1:29276/dev/sign-in  (dev personas, any email)
  Postgres  postgresql://postgres:postgres@127.0.0.1:29277/patchy
  State     /home/you/patchy-cloud/.local/dev  (env, plan.json, dev.log)
  Pids      supervisor 80419, server 80457, postgres 80443
```

Starting is idempotent and the processes outlive the shell, so an agent starts
once and keeps using the instance. Ports come from a hash of the worktree path,
so worktrees run side by side; use the printed URL, not a remembered port. The
server is not watched: after a code change, `pnpm dev stop && pnpm dev`.

| Command                         | What it does                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm dev`                      | Start (or confirm) this worktree's instance and print the plan; `--json` for scripts.             |
| `pnpm dev --clerk`              | The same, signing people in through Clerk; see [Signing in with Clerk](#signing-in-with-clerk).   |
| `pnpm dev --dry-run --json`     | Print the plan this worktree would run with; touches nothing.                                     |
| `pnpm dev status`               | Exit 0 only when the recorded processes are alive and `/healthz` answers.                         |
| `pnpm dev stop`                 | Stop the instance; its data stays.                                                                |
| `pnpm dev logs`                 | Print `dev.log`: every process's lines, wide events and startup failures.                         |
| `pnpm dev reset`                | Stop, wipe `.local/dev/` and start fresh.                                                         |
| `pnpm dev up [scenario]`        | An environment: a scenario's company, people and patches, a logged-in CLI and an agent workspace. |
| `pnpm dev open <person>`        | A browser window with its own profile, signed in as one of the environment's people.              |
| `pnpm dev shot <person> [path]` | A full-page PNG of a page as one person, with its HTTP status and browser errors.                 |
| `pnpm dev down`                 | Stop everything the instance or environment started and delete what it made.                      |

`pnpm --silent dev … --json` keeps pnpm's echo out of the JSON. One
`relation "schema_migrations" does not exist` line in a fresh `dev.log` is
expected. `reset` deletes
the database and published content: use it when a baseline migration was
rewritten under an existing instance or the data is suspect, never to repair a
live database.

The platform migrations were squashed before launch into one baseline per
capability, ids 1 to 8. An instance created before the squash refuses to start:
its ledger disagrees with the record, and the migration error says to run
`pnpm dev reset`, which wipes its data. Its `dev.log` shows the error.

### Signing in and the CLI

People sign in as **dev personas**: `/dev/sign-in` lists everyone, and
`/dev/sign-in?as=<email>&return=<path>` signs in as any email, including one
that was only invited. Invitations are recorded, never mailed. Personas run
only in development on a loopback origin, and the server then listens on
`127.0.0.1` only.

`pnpm patchy` runs the CLI from source and finds this worktree's
`.local/dev/env` from any directory beneath it. A command uses
`PATCHY_API_TOKEN`, then a stored login for the instance, then the seed's
**Dev Machine** key, which publishes as `dev@patchy.local`, the admin of
**Patchy Dev** (`patchy-dev`). `--api-url` bypasses discovery and the seed. Set
`PATCHY_STATE_DIR` to keep a check's logins out of your shared `~/.patchy`.
For `curl` or `psql`, load the env in a separate shell:
`set -a; . .local/dev/env; set +a`.

The seed holds identity rows only; a fresh portal shows **No patches yet**.
`pnpm seed:dev` publishes the accepted HTML fixtures as live tier 0 patches.

### Seeing what a person sees

Company pages answer a cookie-free request with the sign-in door, so read them
as a person. Two `curl` calls do it for server-rendered pages:

```sh
url=http://127.0.0.1:29276   # the plan's API URL
curl -s -c /tmp/jar -o /dev/null "$url/dev/sign-in?as=dev@patchy.local&return=/"
curl -s -b /tmp/jar -i "$url/patchy-dev/plan"
```

A patch's own content renders in a sandboxed frame, so use a browser for it:
`pnpm dev shot <person> <path>` writes a full-page PNG under `.local/shots/`
and prints the final URL, status and every console error and uncaught
exception from the page and its frames. `<person>` is any email, or an
environment person's key or first name.

### Environments: `pnpm dev up`

An environment is this instance plus what a multi-person check or demo needs:

- **People** from the scenario, signed in with `pnpm dev open <person>`,
  `pnpm dev shot` or the personas page.
- **Its own host**, `http://<label>.localhost:<port>`, where the label is the
  worktree's folder plus a hash of its path, so cookies never mix between
  worktrees.
- **A CLI that already publishes**, installed from the instance's release in its
  own folder and logged in as the scenario's publisher. `~/.patchy` is untouched.
- **An agent workspace** under `$XDG_DATA_HOME/patchy-dev/<label>/`, outside the
  worktree so this repo's `CLAUDE.md` never loads there. Its `agent` launcher
  starts Claude Code with only the Patchy skill and pre-approved `patchy` and
  `pnpm` commands; arguments pass through, e.g. `…/agent -p "<task>"`.

[`scenarios/`](../scenarios/README.md) lists the scenarios: `team` (the default)
is three people and no patches; `brightline` is a five-person agency with tier 0,
1 and 2 patches and takes about a minute. `up` is idempotent and resumes a
failed run. Run on a plain personas instance, it turns that instance into the
environment, keeping its data but moving it to the environment's host; a
`--clerk` instance has to go `down` first.
`down` stops the workspace's patch dev sessions and the persons' browsers
before deleting anything.

### Signing in with Clerk

`pnpm dev --clerk` starts a fresh instance that signs people in through your
Clerk development application, for work on sign-in itself. An instance keeps
the way it signs in: `pnpm dev down` before switching. Instances started before
personas became the default still use Clerk.

#### Clerk keys

The server's settings are closed: exported Clerk keys, database URLs and
storage settings in your shell do not reach it. Its keys,
`CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, come from one file per
developer, shared by every worktree and never in the repo:
`${XDG_CONFIG_HOME:-~/.config}/patchy-cloud/dev.env`. With the Clerk CLI signed
in to the **Patchy Cloud** development application:

```sh
clerk env pull --app app_3ImZuFeZJb8038U0oFds84rupA2 --file "${XDG_CONFIG_HOME:-$HOME/.config}/patchy-cloud/dev.env"
```

Or copy both keys from the dashboard as `KEY=value` lines. Use development
keys, not the CI application's, and keep values out of output, chat and git.
A Clerk application of your own needs the session claims in
[Operations: Clerk](OPERATIONS.md#clerk).
The same file may set `CLERK_JWT_KEY` (a quoted PEM, which skips the JWKS fetch)
and `PATCHY_DEV_CLERK_USER_ID=user_...`, which binds the seeded admin to your
Clerk user before your first sign-in (restart after changing it; a healthy
instance does not reseed). Leave `CLERK_AUTHORIZED_PARTIES` unset
locally: a port-specific origin makes worktrees evict each other's sessions.

Sign in at `/join`; without the user binding you create or join a company there.
Then log the CLI in with `PATCHY_API_TOKEN` unset: an agent runs
`pnpm patchy login --json`, gives the person `verificationUrl` and `userCode`,
and after they confirm runs the returned `next` command
(`pnpm patchy login --complete <userCode>`). `pnpm patchy whoami` then names
their machine, not **Dev Machine**. **Inviting from a Clerk instance sends real
email**; use `+clerk_test` addresses and revoke test invitations. The emailed
link signs the person up on Clerk's page, which cannot send them back to this
worktree, so they open `/join` here afterwards.

## A patch repo against this worktree

The cloud (`pnpm dev`) supplies release bytes, identity and metadata; a patch's
local runtime (`patchy dev`) runs its handlers over PGlite and invented fixtures.
With the cloud healthy, initialize beneath this checkout so discovery finds it:

```sh
export PATCHY_STATE_DIR="$PWD/.local/patch-cli"
pnpm patchy init .local/my-patch --purpose "Describe the tool being checked" --json   # add --tier 2 for handlers
cd .local/my-patch
pnpm typecheck
pnpm patchy dev --json
```

`init` already installed the release. Open the returned `url` as the machine's
user and `colleagueUrl` as a fixed non-admin colleague on a second origin;
writes and subscriptions are shared between them. Config and fixture edits need
`pnpm patchy dev stop` and a start; `src/` edits rebuild and reload the shell,
and `server/` edits rebind without a reload. [The CLI's README](../packages/patchy/README.md)
covers fixtures, logs and the dev contract.

To run this worktree's runtime source instead of the installed release, from
the patch repo:

```sh
cloud=/absolute/path/to/this/checkout
node --import "$cloud/node_modules/tsx/dist/loader.mjs" --conditions=development \
  "$cloud/packages/patchy/src/index.ts" dev --foreground
```

To check the packed release after a package change, restart the cloud and
initialize a new repo with a fresh pnpm store **and** metadata cache, since the
release URL is unchanged and pnpm would reuse the old tarball:

```sh
cache=$(mktemp -d)
pnpm_config_store_dir="$cache/store" pnpm_config_cache_dir="$cache/cache" \
  pnpm patchy init .local/packed-check --purpose "Verify the current packed release" --json
```

Stop patch sessions with `pnpm patchy dev stop` before stopping the cloud.

## What to exercise for a change

The tests prove the contracts; this is what to watch work for real before
calling a change done. Done means you observed the behaviour you changed and
can quote it.

- **Serving and sharing.** Publish with the CLI and fetch with and without a
  session. A cookie-free company page answers 401 with the sign-in door,
  `x-patchy-sign-in-url` and `Cache-Control: private, no-store`, and no
  `Location`. Only the current version of a public patch answers 200 with
  `public, max-age=60` and no `Set-Cookie`; older versions keep the door. Cover
  `share … public`, a new publish and `share … company`, and a reader from
  another company, who gets the same 404 as a missing patch.
- **Portal and lifecycle.** Sign in as an owner, an admin and a member: `/` and
  `/patches/<name>`, then `retire`, `delete --yes` and `restore` through the CLI
  and the notices at the patch's address. A source with a published consumer
  refuses retirement with `has_dependants` until `--force`.
- **Company management.** Invite, revoke, change roles, deactivate and
  reactivate from `/company`; deactivation revokes the user's machine tokens and
  the last active admin cannot be demoted.
- **Tier 1 and tier 2 runtime.** Publish a patch repo to the instance and use
  its generated client in two personas' browsers; `pnpm test:browser` and
  `pnpm test:packed-tier2-e2e` assemble the same journeys. Company calls need a
  browser session, never the seed's machine key. For mutations, check replay
  with the same key and rollback after a handler error; contention,
  serialization and dropped clients need the `*.postgres.test.ts` suites.
- **Integrations.** The connector refuses local and private addresses even on a
  dev instance, so the integrations suites exercise discovery and reads against
  disposable Postgres, and patch repos read `fixtures/postgres-<handle>.sql`.
- **Execution engine and fleet.** `pnpm exec vitest run packages/execution` runs
  real workerd. Fleet hosting offline is in
  [Operations](OPERATIONS.md#exercising-the-fleet-offline); local execution
  proves engine compatibility, not Fargate containment.
- **Company databases and primitives.** The real-Postgres and PGlite suites in
  `packages/company-database` and `packages/primitives`; a primitive-free page
  publish never touches a company database.
- **Migrations.** Add the migration to its capability's `src/migrations.ts`
  with the next id in landing order, and never edit a landed one: a database
  that applied it would not see the edit. `apps/server/src/migrations.ts`
  composes them for the server, the dev runner and the test template, and its
  test fails on a duplicate or skipped id. Existing dev instances need
  `pnpm dev reset` when a baseline was rewritten; startup refuses a ledger with
  another history and says so. The baselines were squashed before launch, so no
  upgrade tests exist: write one with the first migration that changes state a
  database must keep, after launch or earlier if something real must be kept.
  The same holds for company inventory, which `Inventory.initialize` creates.
- **The dev runner.** `pnpm exec vitest run scripts/dev`, then the real loop:
  `pnpm dev`, `up`, `shot` and `down` in this worktree.

## How the runner works

`scripts/dev/` is an Effect program. `start` writes `.local/dev/plan.json` and
spawns a detached supervisor that owns one scope holding Postgres and the
server, so either exiting tears the other down. The supervisor migrates, applies
the shared seed (`@patchy/auth/seed`, which the test template also applies),
seeds an environment's scenario, stages the CLI release and starts the server
with a closed environment: the plan, `NODE_ENV=development`, a keyring generated
once per worktree in `.local/dev/dev.env`, and either the personas secret or
Clerk's keys. Development instances execute tier 2 handlers with the local
workerd executor; production refuses it.
