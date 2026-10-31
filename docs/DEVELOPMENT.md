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

`pnpm verify` mirrors CI's jobs: `test (bun)` (`pnpm test:bun`, the offline
tests on Bun, the runtime production runs the server on, leaving out the files
`vitest.bun.config.ts` names as Node-only), `postgres-concurrency`, `cli-smoke` (a
one-second check that the packed harness reaps orphaned processes, the packed CLI
end to end, and the packed Preact runtime), `install` (the installer and CLI on
this machine: each platform's install line, a Node switch, an earlier install
moving, setup's links, a saved key and a file publish against a stub, and the
old-Node refusal), `tier2-smoke` (the packed tier 2 journey) and `browser` (tier 1
and 2 pages in Chromium). CI runs `install` on Linux, macOS and Windows against
one release packed on Linux, switching between Node 22.22.0 and 26.11.1. Locally
it needs only Node and the release `pnpm --filter patchy build` packs, and it
uses this Node for both sides, so its switch changes only the npm prefix; pass
`--node-a` and `--node-b` to switch Nodes too. It keeps
going after a failure and prints a summary. CI also runs `pnpm test` on Node
22.22.0, 24.20.0 and 26.11.1, `cli-smoke` again on Node 26.11.1, and `clerk-live`
on pushes to `main` and same-repository PRs. The server those suites start runs on
Bun, as production runs it; the CLI runs on Node, as people run it. CI's `image`
job, in `server-image.yml`, builds the production image and runs it with
`scripts/server-image-smoke.mjs`, which needs Docker, so `pnpm verify` leaves it out.

On pull requests CI also runs `rollback-rehearsal`. When the PR changes a
capability's `src/migrations.ts`, the handler descriptor schemas
(`packages/api/src/handlers.ts`) or the CLI code that writes descriptors, it
deploys the PR onto data the live release seeded, rolls back to the live
release and forward again, and fails naming the step that broke; otherwise it
passes at once.
Once the PR's CLI writes read-only actions, the PR publishes a tier 2 patch with
one and an agent tool, and the live release must serve it and enforce both. The
live release also ends credentials, by deactivation and Disconnect everything,
and back at the PR the agent connections it ended must stay ended.
[Rolling back](OPERATIONS.md#rolling-back) says what it covers. `pnpm verify`
leaves it out, because it rehearses commits against the commit production runs. `pnpm test:rollback-rehearsal` runs it on HEAD, reading
the Deploy runs with `gh`; `--live <sha>` rehearses against another commit.

CI pins every job to a runner image, `ubuntu-24.04` except `install`'s
`macos-15` and `windows-2025`, and every job that runs the repository's code
to an exact Node patch. Bump the patches by hand in every workflow under
`.github/workflows/` that pins one, like the server image: Node 24 moves with the
`node:24-slim` digest in `apps/server/Dockerfile`, which builds the image.
Bun is pinned once, as the `bun: runtime:<version>` devDependency in
`package.json`, and `pnpm install` downloads it with the lockfile's hashes. It is a
devDependency rather than `devEngines.runtime` because npm, which the packed CLI
tests run from the repository root, refuses a `devEngines.runtime` that isn't Node.
Dependabot doesn't bump it, and pnpm's one-day `minimumReleaseAge` doesn't cover
runtime downloads. To bump it, pick a release at least a day old (`gh release view
bun-v<version> -R oven-sh/bun --json publishedAt`), change the version there and
run `pnpm install` to rewrite the lockfile. Production runs the same Bun, so move
the `oven/bun:<version>-slim` runner in `apps/server/Dockerfile` with it, pinned to
`crane digest --platform linux/amd64 oven/bun:<version>-slim`; the image build
refuses a runner of another version, or one whose `bun` isn't the lockfile's binary.

Format is `bun fmt`, which reads `prettier.config.js` and `.prettierignore` and
checks the whole repo in a fraction of a second. The pre-commit hook is still
`pnpm exec lint-staged`, now running `bun fmt` on what you stage: every worktree of
a clone shares one `.git/hooks`, so the hook's text stays the same across branches
from before and after the switch.
Lint is Oxlint, with its type-aware rules run by `oxlint-tsgolint`; it keeps no
cache and checks the whole repo in seconds.

TypeScript is 7, the native compiler. Builds and `pnpm typecheck` run
`effect-tsgo tsc` (`@effect/tsgo`), the same compiler with the Effect rules in
`tsconfig.base.json` built in; a plain `pnpm exec tsc` compiles without them.
`@effect/tsgo` ships Effect-patched builds of exact TypeScript versions, so a
TypeScript bump waits for a checker release that supports it. For Effect
diagnostics in an editor, point its TypeScript 7 language server at the
patched build: `pnpm exec effect-tsgo get-exe-path` prints it.

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
- A test that fails with no code cause is flaky. CI does not retry, and a test
  that only passes on rerun is still a flake: every Monday the issue labelled
  `flake-report` lists the tests that failed in CI that week and how often they
  passed on a rerun of the same commit (`scripts/flake-report.ts`). Check it and
  the open issues labelled `flaky` before treating a red check as yours; open a
  `flaky` issue for a new flake with the failing run, and fix the cause, not the
  timeout.

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

| Command                                       | What it does                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                    | Start (or confirm) this worktree's instance and print the plan; `--json` for scripts.              |
| `pnpm dev --clerk`                            | The same, signing people in through Clerk; see [Signing in with Clerk](#signing-in-with-clerk).    |
| `pnpm dev --dry-run --json`                   | Print the plan this worktree would run with; touches nothing.                                      |
| `pnpm dev status`                             | Exit 0 only when the recorded processes are alive and `/healthz` answers.                          |
| `pnpm dev stop`                               | Stop the instance; its data stays.                                                                 |
| `pnpm dev logs`                               | Print `dev.log`: every process's lines, wide events and startup failures.                          |
| `pnpm dev reset`                              | Stop, wipe `.local/dev/` and start fresh.                                                          |
| `pnpm dev up [scenario]`                      | An environment: a scenario's company, people and patches, a logged-in CLI and an agent workspace.  |
| `pnpm dev open <person>`                      | A browser window with its own profile, signed in as one of the environment's people.               |
| `pnpm dev shot <person> [path]`               | A full-page PNG of a page as one person, with its HTTP status and browser errors.                  |
| `pnpm dev mcp-token <person> --client <name>` | An agent connection for one person, minted into this instance's database, and its access token.    |
| `pnpm dev compare <person> <path>...`         | Pages before and after as one person, from throwaway instances at both commits, laid out for a PR. |
| `pnpm dev film <person> <flow>`               | A Playwright flow recorded before and after, as captioned mp4s side by side, for a PR.             |
| `pnpm dev transcript <script>`                | CLI lines run before and after as the scenario's signed-in CLI, compared line by line, for a PR.   |
| `pnpm dev trial "<task>"`                     | A fresh agent tries a task before and after, as the scenario's publisher, logged for a PR.         |
| `pnpm dev down`                               | Stop everything the instance or environment started and delete what it made.                       |

`pnpm --silent dev … --json` keeps pnpm's echo out of the JSON. One
`relation "schema_migrations" does not exist` line in a fresh `dev.log` is
expected. `reset` deletes
the database and published content: use it when a baseline migration was
rewritten under an existing instance or the data is suspect, never to repair a
live database.

The platform migrations were squashed before launch into one baseline per
capability, ids 1 to 8. An instance created before the squash refuses to start:
its ledger disagrees with the record, and the migration error says to run
`pnpm dev reset`, which wipes its data. Any failed migration, such as a
duplicate id or a step's SQL error, stops the start: `pnpm dev` prints which
step failed and why, and `dev.log` keeps it.

### Signing in and the CLI

People sign in as **dev personas**: `/dev/sign-in` lists everyone, and
`/dev/sign-in?as=<email>&return=<path>` signs in as any email, including one
that was only invited. Invitations are recorded, never mailed. Personas run
only in development on a loopback origin, and the server then listens on
`127.0.0.1` only. A switch that another site sends the browser to
(`Sec-Fetch-Site: cross-site` or `same-site`) is refused, so a page can't
change who you are mid-consent. Opening the URL yourself, `curl`, and
`pnpm dev open`, `shot`, `film` and `compare` send `none` or no header and
keep working.

`pnpm patchy` runs the CLI from source and finds this worktree's
`.local/dev/env` from any directory beneath it. A command uses
`PATCHY_API_TOKEN`, then a stored login for the instance, then the seed's
**Dev Machine** key, which publishes as `dev@patchy.local`, the admin of
**Patchy Dev** (`patchy-dev`). `--api-url` bypasses discovery and the seed. Set
`PATCHY_STATE_DIR` to keep a check's logins out of your shared `~/.patchy`.
For `curl` or `psql`, load the env in a separate shell:
`set -a; . .local/dev/env; set +a`.

**Agent connections without consent.** `pnpm dev mcp-token <person> --client <name>`
mints an agent connection for one person straight into this instance's
database and prints its access token, for launchers that take a pasted token.
`<person>` is any email of someone in the database, or an environment person's
key or first name; `--json` adds the connection's id, name and site. The token
is the `work` credential, so the CLI's API answers it 401. It lasts a year
instead of an hour, and the connection ends as any other does: disconnected,
after 30 days without a call, or when its person's credentials end. Nothing
else mints one without consent, and no route does. Agents use it at the door,
`<url>/mcp`, where `<url>` is the plan's API URL: the door answers only its own
`Host`, so an environment's door is at its `<label>.localhost` host, never the
`127.0.0.1` alias, and a browser page may call it only from that origin. An
environment's `worker-codex` launcher mints one for you and hands it to Codex;
`--enable mcp_2026_07_28` switches Codex to the newest MCP revision.

**Connecting through consent.** An MCP client opens the consent page at
`/oauth/authorize` with its client id, a redirect its document lists, an S256
PKCE challenge and its state. The instance fetches the client's metadata
document from the internet: Claude Code's is
`https://claude.ai/oauth/claude-code-client-metadata`, whose redirect is
`http://127.0.0.1:<any port>/callback`. Turn agent access on at Company first,
or the page says it's off; a scenario can start with it on. An environment's
`worker-claude` launcher is Claude Code connecting this way. Allow sends `code`, `state` and `iss` to the
redirect, and the code exchanges at `/oauth/token` on `127.0.0.1`; Deny sends
`error=access_denied`. The page and its answers are limited to 10 a minute per
address once signed in.

The seed holds identity rows only; a fresh portal shows the guide to a first patch.
`pnpm seed:dev` publishes two single-file pages, one with a script.

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
  starts Claude Code as a Patchy user who has already set up: the Patchy skill,
  the environment's CLI first on `PATH`, and pre-approved `patchy` and `pnpm`
  commands; arguments pass through, e.g. `…/agent -p "<task>"`. It loads no
  `CLAUDE.md`, `AGENTS.md` or rules from the folders above the workspace, your
  HOME's included, and ignores your shell's `PATCHY_API_TOKEN`, so it publishes
  here as the scenario's publisher.

  The workspace's own `CLAUDE.md` says "Make each new patch or page directly in
  this folder", so the agent's new work lands beside the scenario's repos, where
  `down` removes it, and never in your `~/Patchy`. `up` writes it when it is
  missing and never over one that exists. The launcher sets `PATCHY_API_URL` to
  this instance: a command in a repo bound to another one, production included,
  is refused with an instance mismatch before anything is sent. It's a guard,
  not a sandbox: an explicit `--api-url` still wins, and so does the
  `.local/dev/env` of another checkout running `pnpm dev`, which only ever names
  a local instance. Each session starts clean, with auto memory off and a temp
  folder of its own, made in `$TMPDIR` or `/tmp`; a later launch deletes it once
  that session has ended. Sessions can run side by side; one builder agent per
  patch is the norm, and nothing enforces it.

  Its commands still run as you, with your HOME and npm prefix, so never give it
  the portal's setup line or have it run `patchy setup`. The setup line replaces
  your global `patchy` with this instance's release, and both replace the Patchy
  skill your own agents load from `~/.patchy/skills`, `~/.agents/skills` and
  `~/.claude/skills`. `down` undoes none of it. To watch an agent set Patchy up,
  give it a throwaway machine: see **Front door and onboarding** under
  [What to exercise for a change](#what-to-exercise-for-a-change).

- **Worker agents**: people's own agents using the environment's patches
  through Patchy MCP at `<url>/mcp`, as a person's Claude Code or Codex would.
  A patch's agent area is what they reach, so they need a tier 2 patch with an
  `agent/` folder and agent access on at Company; `brightline` has both. The two
  launchers sit beside `agent` and start in the environment's `workers/`, an
  empty folder of their own, behind the same guard and with a temp folder per
  session. Their CLI state never logs in, so they reach Patchy only through the
  door. Both name the door `patchy-dev-<hash>`, the hash of this worktree's path,
  and pass your arguments through.

  `…/worker-claude` is Claude Code connecting through consent. Run `/mcp`, pick
  the server and Authenticate; the consent page opens in your browser, where you
  sign in as one of the scenario's people and Allow. It loads only that server
  and none of your settings, skills, plugins, connectors or instruction files,
  with auto memory off and Claude Code's default permissions, so it asks before
  every call. Claude Code keeps the sign-in in your own
  `~/.claude/.credentials.json`, whatever the config, keyed by the server's name
  and address: one entry for this worktree's address, which the next sign-in
  there replaces. `down` leaves it: your running
  Claude Code sessions rewrite that file when they refresh, and a second writer
  could lose a refresh and sign you out. Before `down`, `/mcp` › the server ›
  Clear authentication removes it. Trusting the `workers/` folder is recorded in
  your `~/.claude.json`, as for any folder.

  `…/worker-codex <person>` is Codex as that person, a key, email or first
  name. Each launch mints a new agent connection with
  `pnpm dev mcp-token <person> --client Codex`, listed on that person's Your
  machines, and hands its token to Codex in its environment only. Codex runs on
  a home of its own: `CODEX_HOME` is the environment's, whose `config.toml`
  names only the door and turns off your account's apps and plugins, and
  `HOME` is the session's temp folder, so your `~/.codex` config and
  `AGENTS.md`, your skills (`~/.agents/skills` included) and your shell profile
  never load. Your Codex login is linked in, so a refresh is written to it as
  another session of yours would write it; with no login of yours, Codex signs
  in inside the environment and `down` deletes it. One task without a person:
  `…/worker-codex jordan exec --skip-git-repo-check "<task>" < /dev/null`.
  `exec` can't ask before a change, so it refuses `change_patch` unless you add
  `-c 'mcp_servers.patchy-dev-<hash>.tools.change_patch.approval_mode="approve"'`.

[`scenarios/`](../scenarios/README.md) lists the scenarios: `team` (the default)
is three people and no patches; `brightline` is a five-person agency with tier 2
patches and a single-file tier 1 page, agent areas on two of its tier 2 ones and agent access on, and takes
about a minute; `pidgeon` is Lumen Bikes with `pidgeon/support` connected to a
new Pidgeon test address holding customer mail, and a tier 2 Support desk whose
actions answer it; `patchy dev` in its workspace reads that address's mail through
this instance and simulates its sends; `attio` is Northwind Sales with
`attio/crm` connected to Patchy's probe workspace on Attio; `guests` is Harbor Works
with a tier 1 and a tier 2 patch, both shared with Jo at a second company, Pine
Studio, and brightline shares Kudos with Taylor at Cedar Works. `up` shares a
patch's `guests` through the CLI as the publisher. `up` is idempotent and resumes a
failed run. Run on a plain personas instance, it turns that instance into the
environment, keeping its data but moving it to the environment's host; a
`--clerk` instance has to go `down` first.
`down` stops the workspace's patch dev sessions and the persons' browsers
before deleting anything.

### Showing a change in a PR

`pnpm dev compare`, `pnpm dev film`, `pnpm dev transcript` and `pnpm dev trial`
show a change before and after, for a PR body. All four run on **evidence
instances**, never this worktree's own: two shared
clones of the repository under `$XDG_DATA_HOME/patchy-dev/<label>.evidence/`,
one at the base and one at `HEAD`, each brought up by its own runner on fresh
scenario data. When the command ends, however it ends, both are taken down and
their data deleted; the checkouts and their `node_modules` stay, so the next
run skips the clone. One run at a time per worktree: a second fails at once,
and so does `pnpm dev down`, which otherwise deletes the checkouts too.

- **Before** is where `HEAD` left `origin/main`, or the PR's base branch with
  `--pr`, or `--base <ref>`. **After** is `HEAD`. Uncommitted changes and new
  files aren't included, and `--pr` refuses to run with them.
- **The scenario** is this worktree's environment's, or `team`; `--scenario`
  picks another. A base that can't set it up, or lacks the person, shows after
  only and says why.
- **Output** lands in `.local/shots/<run>/`: the PNGs or videos, and the PR
  section as markdown. `--pr <number>` puts the section in that PR's body and
  uploads the files it references; its head must be `HEAD`. Without `--pr`
  the command prints the `gh pr edit` line that would. `--json` prints the
  commits, files, statuses and section.
- **Prerequisites:** Playwright's Chromium, from
  `pnpm exec playwright install chromium`, for `compare`, `film` and a
  scenario whose patches load sample data, such as `brightline`; for `film`, an
  `ffmpeg` built with libx264; for `--pr`, gh 2.102 or later, signed in with
  write access to the repository. Each command checks its own before anything
  starts; a missing Chromium fails a scenario's sample data as its side comes
  up.

`pnpm dev transcript <script>` runs a script of shell lines on each side as
the scenario publisher's signed-in CLI. Each non-blank line is a command, and a
`#` line captions the commands after it. Each line runs in its own `bash -c`,
stdin closed, from the side's agent workspace, with the runner's closed
environment: the side's `bin` first on `PATH`, its `PATCHY_STATE_DIR` set, and
nothing else from your shell, so an exported `PATCHY_API_TOKEN` or
`PATCHY_API_URL` can't steer it. Only files carry between lines; chain with
`&&` on one line. A non-zero exit is recorded and the script goes on. A line
past `--timeout` (60 seconds) is killed and recorded; on `HEAD` that fails the
command and publishes nothing. A line that runs `patchy setup` or installs
globally is refused before anything starts, since lines run as you; the check
catches the plain forms, not every way to write them.

Before comparing, each side's origin becomes `<origin>`, its environment
folder `<env>`, its checkout `<checkout>` and your home folder `~`, each also
in its resolved, `~/…` and `~<user>` forms; every other difference stays. One sanitizer redacts what it collected before anything is
written: the values in each side's CLI state, read before the run, while each
line runs and after it (so a login code a later `patchy logout` clears is still
known), anything shaped like a machine token (`pp_…`) or a login code, any
email address outside the reserved domains the scenarios use (`.example`,
`patchy.local`), written with `@` or `%40`, and secret-named variables the
runner passes. The section says which matched. Redaction is a backstop, not a guarantee; read the section before publishing.

`pnpm dev trial "<task>"` gives a task, in a person's words, to a fresh agent
on each side: the `agent` launcher, run without a person. The task goes
in on stdin to Claude Code's `-p`, with its stream-json events, `--max-turns`
(30), `--no-session-persistence` and auto memory off, and the run is stopped
after `--minutes` (10). Both sides run at once. `--model` passes through to
Claude Code; the default is `sonnet`. Its environment is the runner's closed
one, plus only what Claude Code needs to stay signed in: your HOME, which
holds its login, is already there, and `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`
and `CLAUDE_CODE_OAUTH_TOKEN` pass when set. The launcher's limits hold: its
commands run as you, so a task that mentions `patchy setup` or the portal's
setup line is refused, and `patchy setup` and global `pnpm add`s are denied to
the agent. The launcher pre-approves only some commands, and with no one there
to approve the rest, those are denied and the log says so. Both sides run
this checkout's launcher and workspace `CLAUDE.md`, written over each side's
own, so whatever commit built a side, its agent has the same limits: new work
in the side's workspace, `PATCHY_API_URL` at the side's instance and a temp
folder of its own. The launcher isn't a sandbox: `node`, which it
pre-approves, can read whatever you can.

Of the agent's event stream only a filtered log is kept: whether it finished
and its final answer cut to a sentence or two, each tool call with commands'
exit codes, one line per failure, and the counts of commands, failures and
help lookups. Its reasoning, what its commands printed and the session itself
are never written. The sanitizer reads each side's CLI state every 100ms while
the agents run and after each tool call, and redacts and normalizes every
string before it is written. It also redacts who the agents act as: the email
of the Claude account they sign in with, from `claude auth status`, which
Claude Code puts in its agent's context, and git's `user.email`. An agent on `HEAD` that errors or exits without
a result publishes nothing and fails the command.

A cold run takes under a minute on `team` and about two on `brightline`, plus
a trial's model runs. The `patchy-dev-loop` skill says how to write a flow and
a script; the `pr-evidence` skill covers what each command shows.

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
PostHog, Pidgeon and Attio declarations have no fixture: `patchy dev` reads the real
connection through the cloud's dev read door, as the CLI's machine key
([ADR-0013](adr/ADR-0013-dev-bindings-per-integration.md)), so the connection must
exist on this instance. Pidgeon's sends, replies and triage are simulated in the
dev process, never sent: `patchy dev logs` names each one with its recipients
and subject.
With the cloud healthy, initialize beneath this checkout so discovery finds it:

```sh
export PATCHY_STATE_DIR="$PWD/.local/patch-cli"
pnpm patchy init .local/my-patch --purpose "Describe the tool being checked" --json   # add --tier 2 for handlers
cd .local/my-patch
pnpm typecheck
pnpm patchy dev --json
```

`init` already installed the release. Open the returned `url` as the machine's
user, `colleagueUrl` as a fixed non-admin colleague on a second origin, and
`guestUrl` as the patch's guest from another company on a third: in the patch's
company, never its admin, starting only `guest: true` handlers on tier 2, with no
agent door. Writes and subscriptions are shared between them. Config and fixture edits need
`pnpm patchy dev stop` and a start; `src/` edits rebuild and reload the shell,
and `server/` and `agent/` edits rebind without a reload. A tier 2 repo's agent
tools answer `pnpm patchy dev agent`, which prints what `open_patch` would, and
`pnpm patchy dev agent <tool> '<json>'`, which calls one as the machine's user, or
as the colleague with `--colleague`, the way people's agents call it through Patchy
MCP. [The CLI's README](../packages/patchy/README.md) covers fixtures, logs and the
dev contract.

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
- **Consent.** Open the consent page as a member and as an admin, with agent
  access on and off, for a hosted redirect and a `127.0.0.1` one, at desktop
  and phone widths. Allow and exchange the code, Deny, answer after switching
  persona in another tab (asked again, 409), and answer from another origin
  (403). Nothing reaches the client's redirect except Allow and Deny.
- **Patchy MCP.** `pnpm dev up brightline`, then connect Claude Code through
  consent with the environment's `worker-claude` and Codex with
  `worker-codex <person>`, never with your own config. Have each find the
  person's patches, page through them (more than 50, or `detail: "tools"` over
  large tool descriptions), open one and read and change through it, as a
  member and an admin, meeting the patches' rules (a member can't approve their
  own spend; Proposal needs a value and an owner). With agent access off, a call
  names the admins. Your own `~/Patchy`, `~/.codex/config.toml` and
  `~/.claude/settings.json` gain nothing.
- **Portal and lifecycle.** Sign in as an owner, an admin and a member: Home at
  `/` (open a few patches first, so Your usual and New to you have something to
  show; `pnpm dev shot <person> /<company>/<patch>` records an open), a search on
  it, `/patches` and its tabs, `/guide` and `/patches/<name>`, then `retire`,
  `delete --yes` and `restore` through the CLI
  and the notices at the patch's address. A source with a published consumer
  refuses retirement with `has_dependants` until `--force`.
- **Company management.** Invite, revoke, change roles, deactivate and
  reactivate from `/company`; deactivation revokes the user's machine tokens and
  the last active admin cannot be demoted.
- **Front door and onboarding.** `pnpm test:packed-cli-e2e` runs the
  `/llms.txt` install line on a clean HOME and npm prefix. To watch an agent
  follow the portal's setup line, give it a throwaway machine, never the
  environment's agent: a folder under `/tmp`, outside your HOME so no
  `CLAUDE.md` above it loads, with its own HOME and npm prefix, no `PATCHY_*`,
  and a `PATH` of its `~/.local/bin`, Node's real directory (not a version
  manager's shim) and the system tools, with no other `patchy` on it. Keep its
  npm prefix: the installer removes a `patchy` it finds in npm's global prefix.

  ```sh
  url=http://127.0.0.1:29276   # the URL pnpm dev or up printed
  m=$(mktemp -d /tmp/patchy-machine.XXXXXX) && mkdir "$m/home" "$m/work"
  cat > "$m/env.sh" <<EOF
  export HOME='$m/home' npm_config_prefix='$m/npm' npm_config_cache='$m/npm-cache' npm_config_userconfig=/dev/null
  export PATH='$m/home/.local/bin:$(dirname "$(node -p process.execPath)")':/usr/bin:/bin
  unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME PATCHY_API_URL PATCHY_API_TOKEN PATCHY_STATE_DIR
  EOF
  (. "$m/env.sh"; command -v patchy)   # must print nothing
  cd "$m/work" && CLAUDE_ENV_FILE="$m/env.sh" claude --setting-sources project --strict-mcp-config "Set up Patchy using $url/llms.txt"
  ```

  `CLAUDE_ENV_FILE` applies `env.sh` to every command the agent runs, while
  Claude Code itself keeps your HOME and so your login; setting HOME on `claude`
  logs it out, and never copy its credentials file. The two flags leave out
  your own settings, skills and connectors. Installers before `~/.patchy/cli`
  put `patchy` beside Node, so if the check prints a path, your own earlier
  `patchy` is there: use a Node version without one. The installer should
  print paths inside `$m` and stop at the login handoff. To run the install line without an
  agent, paste it into `(. "$m/env.sh" && cd "$m/work" && <line>)`. `rm -rf "$m"`
  removes the machine.

- **Tier 1 and tier 2 runtime.** Publish a patch repo to the instance and use
  its generated client in two personas' browsers; `pnpm test:browser` and
  `pnpm test:packed-tier2-e2e` assemble the same journeys. Company calls need a
  browser session, never the seed's machine key. For mutations, check replay
  with the same key and rollback after a handler error; contention,
  serialization and dropped clients need the `*.postgres.test.ts` suites.
- **Integrations.** The connector refuses local and private addresses even on a
  dev instance, so the integrations suites exercise discovery and reads against
  disposable Postgres, and patch repos read `fixtures/postgres-<handle>.sql`.
  PostHog only reaches PostHog Cloud, so its suites inject a PostHog double
  (`packages/integrations/src/test/posthog.ts`) and never contact a real project.
  Dev reads run the patch repo's binding against the real dev read door over that
  double (`DevReads.test.ts`); in `patchy dev` they appear on the connection's
  page as Dev calls. Connecting PostHog on a local instance needs a real key and
  project, so check those by hand only with a disposable project. Pidgeon's dev
  reads go through the same door, offline over answers recorded from Pidgeon in
  the same suite and live in the live tier (`PidgeonDev.live.ts`); its simulated
  writes reach neither.
  Pidgeon is Pidgeon itself, in test mode, where mail never leaves Pidgeon and a
  test address lasts a day. `pnpm dev up pidgeon` connects `pidgeon/support`
  through the connect page in a browser with a test admin key,
  `PIDGEON_TEST_ADMIN_KEY` from the environment or from
  `~/.config/patchy-cloud/dev.env` as Clerk's keys are, creating a new test
  address on pidgeon.email, then delivers the scenario's mail to it as mail from
  outside, through Pidgeon's `POST /test/inbound` (which carries no
  attachments), with the desk's replies sent from the address, its labels and
  statuses, each write under its own Idempotency-Key so a resumed `up` sends
  nothing twice. Without the key, or with one that isn't a test key, it says so
  and skips Pidgeon and the patches that declare it. `up` records each test address it asks Pidgeon
  for in the environment folder, and `pnpm dev down` and `reset` take those
  down with the test key, needing no instance: they revoke each Patchy-named
  test key below admin that reaches only those addresses, delete the addresses,
  then wipe. If any of it fails, for want of the key or a refusal from Pidgeon,
  they name the addresses and remove nothing; fix that and run them again. A
  recorded address Pidgeon already deleted is named and passed over: its key
  reaches nothing, and `pnpm test:pidgeon:sweep` revokes it. An
  address connected by hand isn't recorded: delete its connection before `down`,
  which revokes its key, or the live tier's stale sweep revokes the key once
  Pidgeon has deleted the address, a day after it was made. `compare`, `film`
  and `transcript` hand the key in their environment to their instances' `up`
  and `down` alone. The offline suites need no Pidgeon: they seed connections and answer revokes and
  reads through `packages/integrations/src/test/pidgeon.ts`. What Pidgeon does
  is the live tier's, `pnpm test:pidgeon` with `PIDGEON_TEST_ADMIN_KEY` set
  (`node --env-file=$HOME/.config/patchy-cloud/pidgeon-test.env node_modules/vitest/vitest.mjs run --config vitest.pidgeon-live.config.ts`),
  never in `pnpm test` or `pnpm verify`; CI runs it when the repository has the
  secret. It makes failures with Pidgeon's `Pidgeon-Test-Fail`
  header, creates only test addresses of its own, tags every key it mints with
  its run, removes both when it ends, and asserts only on what it made: the
  account holds an address that isn't ours. Every run and every developer's dev
  environment share that account's budgets: 120 requests a minute, 300 test
  mints an hour and, on the free plan, 10 active keys, test keys included, two of
  them the admin keys. So the suite refuses a key that isn't a test key before
  changing anything, paces itself to about 48 calls a minute, keeps at most
  three of its own keys alive at once and fails a test that would mint past
  six, prints the most it held, waits out a 429 or a full key count (402), and
  stops using Pidgeon 20 minutes after it starts. It changes an address's send
  policy, approval or holding only on its own run's test addresses, through the
  harness. Before it starts it
  sweeps what nobody can still be using: run-tagged test addresses older than an
  hour, then Patchy-named test keys below admin that reach nothing; when it ends,
  its own, however it ended. The sweep never touches anything else. CI runs it in
  its own workflow, `Pidgeon live`: `pidgeon-changes` decides whether it runs,
  `pidgeon-suite` runs it one run at a time, queued and never cancelled, then
  `pnpm test:pidgeon:sweep` however it ended, and `pidgeon-live`, the check to
  require, passes only when the suite passed or had no reason or no key to run.
  Attio is Attio itself: Patchy's probe workspace, seeded with synthetic CRM
  data and read with its read-only key, `ATTIO_TEST_READ_KEY` from the
  environment or `~/.config/patchy-cloud/dev.env`. `pnpm dev up attio` connects
  `attio/crm` through the connect page with it, and skips the connection without
  it; it only reads, so `down` has nothing to take down in Attio. The offline
  suites carry correctness over a scripted Attio
  (`packages/integrations/src/test/attio.ts`) answering in the shapes Attio
  answered the probe with, hand-written, never its raw output, which holds a
  member's name and email: the key check's every refusal, discovery's bounds,
  budget and deadline, the write-scope disconnect, Replace key, admission and
  every error class. The live tier, `pnpm test:attio` with the read key set,
  only catches Attio drifting: the key check, discovery of the probe workspace
  within its bounds and deadline, and Replace key with the same key. Runs share
  the workspace's 100 reads a second, so it paces itself to about 20 requests a
  second and sits out a 429 outside the call's deadline. The workspace's Pro
  trial ends around 2026-11-10; on Attio's Free plan it keeps companies, people,
  deals and lists but no custom object, and a case about one skips. CI runs it in
  its own workflow, `Attio live`, on main and on this repository's pull requests
  that touch Attio, one run at a time and never cancelled; `attio-live` is
  informational and never a required check.
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
  another history and says so. Production holds data it must keep, so a
  migration that changes kept state comes with an upgrade test, as
  `0009_whats_new_seen` does in `packages/companies/src/migrations.test.ts`.
  Company inventory, which `Inventory.initialize` creates, has no upgrade path
  yet: the first change to an existing inventory structure adds one, with its
  tests.
  Commit, then `pnpm test:rollback-rehearsal` checks that the live release
  still starts and serves on the schema your commit leaves.
- **The dev runner.** `pnpm exec vitest run scripts/dev`, then the real loop:
  `pnpm dev`, `up`, `shot`, `compare`, `film`, `transcript` and `down` in
  this worktree, and the `agent`, `worker-claude` and `worker-codex` launchers.
  `trial` is part of the loop too, at a model run per side.

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
