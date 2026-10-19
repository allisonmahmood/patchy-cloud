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

## 2. Exercise the change

- **The CLI.** `pnpm patchy …` runs from source and publishes as **Dev
  Machine**, `dev@patchy.local`, the admin of Patchy Dev. For login or logout
  checks, keep `PATCHY_API_TOKEN` unset and set
  `PATCHY_STATE_DIR="$PWD/.local/cli-check"` on every command.
- **A server-rendered page as a person.** Sign in with a cookie jar, then fetch:

  ```sh
  curl -s -c /tmp/jar -o /dev/null "$url/dev/sign-in?as=<email>&return=/"
  curl -s -b /tmp/jar -i "$url/<path>"
  ```

- **What a person sees, patch frames included.** `pnpm dev shot <person> <path>`
  writes a full-page PNG and prints the final URL, status and the browser's
  errors. Read the PNG to look at it. `<person>` is any email, or an
  environment person's key or first name.
- **The environment's agent.** `pnpm dev up` prints an `agent` launcher:
  Claude Code in the environment's workspace with the Patchy skill, publishing
  as the scenario's publisher. It ignores the shell's `PATCHY_API_URL` and
  `PATCHY_API_TOKEN` and loads no `CLAUDE.md` from the folders above its
  workspace. Give it a task with `…/agent -p "<task>"`. It is a Patchy user who
  has already set up, and its commands run as the person, with their HOME and
  npm prefix: never give it the portal's setup line or have it run
  `patchy setup`. The setup line replaces the person's global `patchy`, both
  replace their Patchy skill, and `pnpm dev down` undoes neither. Onboarding
  checks use DEVELOPMENT's throwaway machine, under **Front door and
  onboarding**.
- **A patch repo.** Follow DEVELOPMENT's **A patch repo against this worktree**.
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
  gives the task to a fresh agent on both sides, each side's `agent` launcher
  run without a person, and logs how each attempt went: finished or not, its
  answer in brief, its commands with exit codes and a line per failure. Each
  side is a model run. Phrase the task as a person would ask their agent,
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
