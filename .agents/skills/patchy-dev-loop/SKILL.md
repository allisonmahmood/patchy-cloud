---
name: patchy-dev-loop
description: Run a change against this worktree's local Patchy Cloud instance. Use when asked to check that a change works for real, to start or stop the dev instance, to drive the patchy CLI locally, to see a page as a signed-in person, to capture pages, a flow, CLI lines or a fresh agent's attempt at a task before and after for a PR, or when a dev instance is reported unhealthy.
metadata:
  internal: "true"
---

# The dev loop

`pnpm dev` runs one complete Patchy Cloud per git worktree, and people sign in
as dev personas, so nothing needs an account. [DEVELOPMENT](../../../docs/DEVELOPMENT.md)
is the reference; its **What to exercise for a change** section says what to
watch for each area.

## 1. Start

```sh
pnpm dev                 # one instance with the seeded Patchy Dev company
pnpm dev up [scenario]   # an environment: a scenario's company, people and patches
```

Use an environment for anything with more than one person (live sync,
assignments, admin-only rules, invitations) and for demos. Use the URL each
start prints; ports can change between starts. A failed start names its log:
read `pnpm dev logs`. A failed migration also prints which step failed and why.

Done when `pnpm dev status` exits 0.

On the Activepieces prototype branch, use `npm --prefix
packages/integrations/prototype-activepieces run local` for its alternate local
entrypoint, two companies and simulated provider. The prototype README describes
the sign-in links and test patches. Restart it with this launcher after `pnpm dev
stop`; plain `pnpm dev` uses the native source. Status, logs, shot and stop still
use the same worktree plan. `npm --prefix packages/integrations/prototype-activepieces
run local:slack` starts direct Slack bot-token entry inside Patchy with real
provider requests; no tokens are preloaded. Stop before switching modes. This
mode needs a token from an existing installed Slack app with `channels:read`;
the user enters it in Patchy, never in chat. The automated Slack test redirects
the actual module to a loopback mock and is not evidence of a real provider call.

## 2. Exercise the change

- **The CLI.** `pnpm patchy …` runs from source and publishes as **Dev
  Machine**, `dev@patchy.local`, the admin of Patchy Dev. For login or logout
  checks, keep `PATCHY_API_TOKEN` unset and set
  `PATCHY_STATE_DIR="$PWD/.local/cli-check"` on every command.
- **A server-rendered page as a person.** Sign in with a cookie jar, then fetch.
  A persona switch that another site sends the browser to is refused 403;
  `curl` and the dev tools send no `Sec-Fetch-Site` or `none`, so they switch:

  ```sh
  curl -s -c /tmp/jar -o /dev/null "$url/dev/sign-in?as=<email>&return=/"
  curl -s -b /tmp/jar -i "$url/<path>"
  ```

- **What a person sees, patch frames included.** `pnpm dev shot <person> <path>`
  writes a full-page PNG and prints the final URL, status and the browser's
  errors. Read the PNG to look at it. `<person>` is any email, or an
  environment person's key or first name.
- **An agent connection's token.** `pnpm dev mcp-token <person> --client <name>`
  mints an agent connection straight into this instance's database and prints
  its access token, which lasts a year; `--json` adds the connection. `<person>`
  is as for `shot`. The token is the `work` credential: the CLI's API answers it 401. The connection ends as any other: disconnected, 30 days without a call,
  or its person's credentials ending. Only this command mints one without
  consent. Agents send it to the door at `<url>/mcp`, the plan's API URL: the
  door answers only its own `Host`, so an environment's door is at its
  `<label>.localhost` host, not `127.0.0.1`.
- **Consent.** `/oauth/authorize` with a real client's document, such as
  Claude Code's (`https://claude.ai/oauth/claude-code-client-metadata`, any
  `http://127.0.0.1:<port>/callback`), an S256 challenge and a state shows the
  consent page; agent access must be on at Company. DEVELOPMENT's
  **Connecting through consent** has the details. The page allows 10 loads
  and answers a minute per address.
- **The environment's agent.** `pnpm dev up` prints an `agent` launcher:
  Claude Code in the environment's workspace with the Patchy skill, publishing
  as the scenario's publisher. It ignores the shell's `PATCHY_API_TOKEN` and
  loads no `CLAUDE.md` from the folders above its workspace. The workspace's
  own `CLAUDE.md` puts its new patches and pages in the workspace, where
  `pnpm dev down` removes them. Its `PATCHY_API_URL` is the environment's
  instance, so a repo bound to another one, production included, refuses its
  commands unless it passes `--api-url`. Each session has auto memory off and a
  temp folder of its own. One builder agent per patch is the norm; nothing
  enforces it. Give it a task with `…/agent -p "<task>"`. It is a Patchy user who
  has already set up, and its commands run as the person, with their HOME and
  npm prefix: never give it the portal's setup line or have it run
  `patchy setup`. The setup line replaces the person's global `patchy`, both
  replace their Patchy skill, and `pnpm dev down` undoes neither. Onboarding
  checks use DEVELOPMENT's throwaway machine, under **Front door and
  onboarding**.
- **Worker agents.** `pnpm dev up` also prints `worker-claude` and
  `worker-codex <person>`: people's own agents using the environment's patches
  through Patchy MCP, which reach a tier 2 patch's `agent/` tools while the
  company's agent access is on (`brightline` has both). Neither loads the
  person's instructions, skills, plugins or config, and both reach Patchy only
  through `/mcp`. `worker-claude` signs in through consent: `/mcp` ›
  Authenticate opens the consent page in the person's browser, where they sign
  in as one of the scenario's people; its sign-in stays in their
  `~/.claude/.credentials.json` after `down`, one entry per worktree and address, which
  `/mcp` › Clear authentication removes. `worker-codex <person>` mints a new
  connection as that person on each launch. For one task without a person:
  `…/worker-codex jordan exec --skip-git-repo-check "<task>" < /dev/null`, and
  to let it change, add
  `-c 'mcp_servers.patchy-dev-<hash>.tools.change_patch.approval_mode="approve"'`
  with the server name its `config.toml` holds. DEVELOPMENT's **Environments**
  has what each needs.
- **A patch repo.** Follow DEVELOPMENT's **A patch repo against this worktree**.
  A tier 2 repo's agent tools answer `pnpm patchy dev agent`, which lists them as
  an agent sees them, and `pnpm patchy dev agent <tool> '<json>' [--colleague]`,
  which calls one as a dev person, so open dev pages show its changes live.
  Postgres declarations read invented fixtures. PostHog declarations have none:
  `patchy dev` reads the real connection through this instance, as the CLI's
  key, and each read shows as a Dev call on the connection's page. Connecting
  PostHog here takes a real key and project, so check dev reads through the
  suites' PostHog double unless the person hands you a disposable project.
- **Clerk sign-in, its handshake or real invitation mail.** These need
  `pnpm dev --clerk`, the person's Clerk keys and their browser; follow
  DEVELOPMENT's **Signing in with Clerk** and ask the person for each sign-in.

## 3. Verify

Done when a response, page or screenshot shows the behaviour you changed and
you have quoted it: the status line and headers, or the PNG's path and what it
shows. A successful publish or a bare 200 says nothing about who can see a page
or what it shows.

## 4. After a code change

The server is not watched: `pnpm dev stop && pnpm dev`. Data survives the
restart. `pnpm dev reset` wipes it, for a rewritten baseline migration or
suspect data.

## 5. Stop

Stop what you started: `pnpm dev stop` keeps the data, `pnpm dev down` deletes
the instance or environment. Stop `pnpm patchy dev` sessions before the cloud.
An instance that was already running when you arrived belongs to whoever
started it; leave it up.

Before calling a change ready to ship, run `pnpm verify`.

## Before and after, for a PR

`pnpm dev compare`, `pnpm dev film`, `pnpm dev transcript` and `pnpm dev trial`
capture both sides on throwaway evidence instances: clones at the base and at `HEAD`, on
fresh scenario data, taken down when the command ends. They never use this worktree's instance, so
it can be up or down. They show commits: commit first, and with `--pr` push
too. DEVELOPMENT's **Showing a change in a PR** has the details and
prerequisites; the `pr-evidence` skill says what each shows.

- `pnpm dev compare <person> <path>... [--width 1280,390]` takes a full-page
  PNG of every path at every width on both sides, patch frames grown to their
  content, and prints each side's status and browser errors.
- `pnpm dev film <person> <flow-file> [--path /] [--after-only]` runs a flow on
  both sides and joins the two videos side by side.
- `pnpm dev transcript <script> [--timeout 60]` runs a script of shell lines on
  both sides as the scenario's signed-in CLI and compares each line's output,
  exit code and time.
- `pnpm dev trial "<task>" [--model sonnet] [--max-turns 30] [--minutes 10]`
  gives the task to a fresh agent on both sides, this checkout's `agent`
  launcher written into each side and run without a person, and logs how each
  attempt went: finished or not, its answer in brief, its commands with exit
  codes and a line per failure. Each side is a model run. Phrase the task as a person would ask their agent,
  never for `patchy setup` or the portal's setup line: its commands run as
  you.
- "Before" is where `HEAD` left `origin/main`; `--base <ref>` picks another
  commit, and `--pr <number>` the PR's base branch. Both sides run this
  worktree's scenario, or `team`; `--scenario brightline` has patches of every
  tier.
- `--pr <number>` puts the section in the PR body and uploads its files. A
  re-run replaces its own section: compare's is keyed by the person (`--key`
  overrides), film's by the flow's file name. Without `--pr`, the section is
  written under `.local/shots/` with the `gh` line that publishes it. A
  transcript's is keyed by the script's file name, a trial's by the task's
  first words (`--key` overrides).

A flow is a module whose default export drives a page that is already signed
in as the person, at `--path`. Keep it outside the repo's tracked files, such
as `.local/flows/`:

```ts
import type { Flow } from "../../scripts/dev/src/film.ts";

export default (async ({ page, step }) => {
  await step("Search Home for kudos"); // captions the video and holds it
  await page.getByPlaceholder(/search/i).fill("kudos");
  await page.keyboard.press("Enter");
  await step("Open it");
  await page.getByRole("link", { name: /kudos/i }).first().click();
  await page
    .frameLocator("iframe#patch")
    .getByRole("heading", { name: "Kudos", exact: true })
    .waitFor();
}) satisfies Flow;
```

- `page` is Playwright's. Relative URLs resolve against each side's instance.
  A patch's content is inside `frameLocator("iframe#patch")`.
- Use role, label and placeholder locators. Actions wait 5 seconds and
  navigations 15, so a missing element ends the take quickly.
- A flow for something new fails on the base: that take stops at the missing
  element, captioned in red, and the command still succeeds. A flow that fails
  on `HEAD` keeps its video, publishes nothing and exits 1.
- Each side starts from fresh scenario data, so a flow that writes runs the
  same every time.

A transcript script is a text file, also kept outside tracked files, such as
`.local/transcripts/`. Each non-blank line is a command, and a `#` line
captions the commands after it:

```sh
# A patch's log
cd new-business && patchy logs --limit 1
# Signing in, then out
patchy login
patchy logout
patchy whoami
```

- Each line runs in its own `bash -c` from the side's agent workspace, which
  holds the scenario's patch repos, with stdin closed. Only files carry over:
  chain with `&&` on one line.
- `patchy` is the side's own release, logged in as the scenario's publisher.
  Your shell's `PATCHY_API_TOKEN`, `PATCHY_API_URL` and every other variable
  stay out.
- A non-zero exit is recorded and the script goes on. A line past `--timeout`
  is killed; on `HEAD` that fails the command and publishes nothing.
- Lines run as you, with your HOME. A line running `patchy setup` or a global
  install is refused before anything starts.
- Origins and paths read `<origin>`, `<env>`, `<checkout>` and `~`; every
  other difference shows. Collected secrets read `[redacted]`. Read the
  section before publishing anyway.
