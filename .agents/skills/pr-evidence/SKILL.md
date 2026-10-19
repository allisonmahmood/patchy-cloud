---
name: pr-evidence
description: "Evidence for a pull request: the ways to show a change working, and how to publish them. Use when writing or updating a PR body."
metadata:
  internal: "true"
---

# Showing a change

A PR body is the merge summary in `.github/PULL_REQUEST_TEMPLATE.md`. Whoever
merges reads it in under a minute and decides without checking out the branch,
so its **Look at** carries evidence: the change working, where they can see it.

The kinds below are options. Each says what it shows, how to make it, roughly
what it costs and where it goes wrong. Pick what shows your change; one that
touches a page, a flow and a command may want one kind or several. The summary
is done when each thing in Look at carries evidence that matches the PR's head.

## Pages before and after: `pnpm dev compare`

- **Shows** pages as one person sees them on the base and on the head:
  full-page PNGs at each width, patch frames grown to their content, with each
  side's HTTP status and browser errors.
- **Make** it with `pnpm dev compare <person> <path>... [--width 1280,390]`,
  with the change committed. Both sides run on throwaway evidence instances at
  exact commits with fresh scenario data, so the PNGs hold only scenario data.
  `--pr <number>` lays the section out in the PR body and uploads its PNGs;
  without it, the section is written under `.local/shots/` with the `gh` line
  that publishes it. Read the PNGs before publishing.
- **Costs** about 45 seconds for one page on `team` from cold, both sides in
  parallel, and about two minutes for five `brightline` pages at two widths.
  Each run starts two instances and takes them down when it ends.
- **Gotchas.** Byte-identical PNGs say "No visible change" and leave "before"
  out. Portal pages that show times, such as "Opened 1 minute ago", can differ
  anyway. A page that scrolls inside an element is cut at that element's fold,
  and the section says so. A base that can't set up the scenario or lacks the
  person shows after only and says why. Desktop widths put "after" full width
  with "before" one click away; phone widths sit side by side. `pnpm dev shot`
  captures the worktree's own instance, which can hold the developer's data
  and uncommitted code: it is for looking locally, not for a PR.

## A flow on video: `pnpm dev film`

- **Shows** a flow working: the same steps on the base and the head, side by
  side, captioned, with a cursor and a ring at each click.
- **Make** it by writing a flow (the `patchy-dev-loop` skill shows one) and
  running `pnpm dev film <person> <flow-file> [--path <start>]`.
  `--after-only` films the head alone. `--pr` publishes as compare does.
- **Costs** about a minute on `brightline` once the checkouts exist. A take of
  ten seconds is about 0.1 MB, and side by side about 0.25 MB.
- **Gotchas.** A flow for something new fails on the base: that take ends on
  the error in red, and the command still succeeds. A flow that fails on the
  head exits 1 and publishes nothing. The joined video is 2560px wide, so each
  side shows about 440px inline; full screen shows the detail.

## CLI lines before and after: `pnpm dev transcript`

- **Shows** what a change does to the CLI's interface: each line's output,
  exit code and time on the base and the head, run as the scenario's
  signed-in CLI. A changed line shows after's output and the diff from before;
  an unchanged line folds to "no change".
- **Make** it by writing a script, one shell line per command with `#` lines
  as captions (the `patchy-dev-loop` skill shows one), and running
  `pnpm dev transcript <script>` with the change committed. Lines start in the
  agent workspace, which holds the scenario's patch repos, so on `brightline`
  `cd new-business && patchy logs` reads a published patch. `--pr` publishes
  as compare does, with nothing to upload.
- **Costs** about a minute and a half on `brightline` from cold, both sides in
  parallel. A `patchy` line adds under a second on each side.
- **Gotchas.** Each side's origin and paths are normalized, and nothing else:
  ids, times and the clock time a login code expires all differ between two
  fresh instances and show as changes. Before is the base's own CLI release,
  so a command or flag the base lacks fails there, which is often the point.
  Secrets the sanitizer collected read `[redacted]`, and the section says
  which sources matched; it is a backstop, so read the section before
  publishing. stdin is closed, so a command that would wait for a person
  reports instead. Lines run as you, with your HOME: `patchy setup` and global
  installs are refused, and nothing else a line writes outside the workspace
  is undone. Past 30 lines, the middle of an output or diff is cut, keeping
  the first 20 and last 10; `--json` has all of it.

## A fresh agent trying a task: `pnpm dev trial`

- **Shows** how an agent copes with the CLI and the Patchy skill on the base
  and on the head: whether it finished, its answer in a sentence or two, and
  a table of its commands, failures, help lookups and minutes, with each
  side's log folded below. The log lists each tool call, a command with its
  exit code, and one line per failure. It is for a change that should make
  something easier or possible for people's agents, where guessed flags,
  retries and help lookups are the symptom.
- **Make** it with `pnpm dev trial "<task>"`, the change committed, the task
  phrased as a person would ask their agent: on `brightline`, "show me the
  last few log lines of the new-business patch". Each side gives it to its
  environment's `agent` launcher, Claude Code as the scenario's publisher with
  the release's Patchy skill and no personal instructions or settings, run
  without a person within `--max-turns` (30) and `--minutes` (10). `--model`
  passes through; the default `sonnet` is close to what people's agents run.
  `--pr` publishes as compare does, keyed by the task's first words or
  `--key`.
- **Costs** a model run per side, both at once, on top of about a minute and
  a half to bring `brightline` up. A short `brightline` task on Sonnet came to
  about ten cents a side; the price Claude Code reports, at API rates, prints
  on stderr and lands in `--json`.
- **Gotchas.** One run is a smell test, not a measurement: agents vary, so a
  difference of a command or two says little. The launcher pre-approves only
  some commands, such as `patchy`, `pnpm` and reading files, and no one is
  there to approve the rest, so a chained command that leaves the workspace,
  or `npx`, shows as `denied`: that is the launcher's limit, not the change's.
  Its commands run as you, with your HOME: a task that mentions
  `patchy setup` or the portal's setup line is refused, and `patchy setup` is
  denied to the agent. Only the log is kept, never the agent's reasoning, what
  its commands printed or the session; collected secrets read `[redacted]`.
  Claude Code tells its agent which account it is signed in as, so an answer
  can name your email: the trial redacts that account's email and git's, and
  any address outside the scenarios' example domains. Read the section before
  publishing anyway: the answer is the agent's own words. A base whose
  launcher predates #701 shows after only, and an agent that errors or gives
  no result on the head publishes nothing. The Patchy MCP (#730) isn't part
  of the agent yet.

## A test, red then green

- **Shows** that the change does what it claims and keeps doing it. The
  reviewer reads one test instead of the whole diff.
- **Make** it by running the new or changed test over the base commit's code,
  where it fails, then over the head's, where it passes. With the change
  committed, `git restore --source=<base> -- <changed source files>` puts the
  old code under the new test, and `git restore -- <files>` brings the change
  back. `pnpm exec vitest run <file> -t "<name>"` runs one test. Quote the
  failing assertion and the passing line.
- **Costs** a few seconds a file. The test setup starts its own Postgres.
- **Gotchas.** A test that fails on base because an import or export is
  missing shows only that the code changed. The red worth quoting is the
  assertion's.

## Numbers before and after

- **Shows** that a performance change moved what it set out to move, by how
  much, against how much noise.
- **Make** them with the same measurement on the base and the head: same
  machine, same data, several runs each, alternating sides. Report the median
  and the spread, with the command, the data size and whether caches were
  warm. Medians read best in a small table; raw runs go in `<details>`.
- **Costs** as long as the runs take.
- **Gotchas.** Other work on the machine skews any single run, so one run is an
  anecdote; alternating sides spreads the load over both.

## Command output

- **Shows** that a command behaves as claimed: its output, its `--json` shape,
  its exit code and its refusals. ADR-0004 is the CLI's contract.
- **Make** it with `pnpm dev transcript` for the `patchy` CLI, above. For what
  it doesn't run, such as `pnpm dev` itself, a repo script or a command that
  needs a person at the terminal, run the command and paste it with its output
  in a fenced block, with `echo $?` after it where the exit code matters.
- **Costs** seconds a command.
- **Gotchas.** Output carries what the shell can reach: tokens, home paths,
  local ports, ids. Trim it to what makes the point. The worktree's own
  instance can hold your data. An exported `PATCHY_API_TOKEN` wins over stored
  and seeded keys. An exported `PATCHY_API_URL` steers an environment's
  installed CLI, `<env>/bin/patchy` beside the `agent` launcher `pnpm dev up`
  prints, which otherwise reads `~/.patchy`. Any of these can point at
  production. The launcher clears both and sets its state dir; by hand, run
  `env -u PATCHY_API_URL -u PATCHY_API_TOKEN PATCHY_STATE_DIR=<env>/cli-state <env>/bin/patchy …`.

## Publishing

- `gh pr create`, `gh pr edit` and `gh pr comment` take `--attach <file>`, once
  per file. Each `![alt](./after.png)` in the body that names an attached file
  becomes its upload, inside tables and `<details>` too. It needs gh 2.102 or
  later (`gh --version`).
- An attached `![name](x.mp4)` alone in its own paragraph, with blank lines
  around it, plays inline; sharing a paragraph, it becomes a link.
- At most 50 attachments per command and 10 MB per file.
- `compare`, `film`, `transcript` and `trial` with `--pr` keep each section between
  `<!-- patchy-dev:<command>:<key> -->` markers. A re-run replaces its own
  section wherever it was moved and leaves the rest of the body alone. When
  some uploads fail, gh still updates the body; the command names the files
  left as local paths and exits 1, and running it again replaces the section.
- Uploads are public by URL, and so is the repo: only scenario data, never
  tokens.
- Re-run after a push that changes what the evidence shows. Editing the body
  doesn't re-run CI.
