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
- **Make** it by running the command and pasting it with its output in a
  fenced block, with `echo $?` after it where the exit code matters.
  `env -u PATCHY_API_URL -u PATCHY_API_TOKEN pnpm patchy …` runs the CLI from
  source against the worktree's instance (the `patchy-dev-loop` skill),
  without the shell's Patchy settings.
- **Costs** seconds.
- **Gotchas.** Output carries what the shell can reach: tokens, home paths,
  local ports, ids. Trim it to what makes the point. An exported
  `PATCHY_API_TOKEN` wins over stored and seeded keys. An exported `PATCHY_API_URL`
  steers an environment's installed CLI, `<env>/bin/patchy` beside the `agent`
  launcher `pnpm dev up` prints, which otherwise reads `~/.patchy`. Any of these
  can point at production. The launcher clears both and sets its state dir; by
  hand, run
  `env -u PATCHY_API_URL -u PATCHY_API_TOKEN PATCHY_STATE_DIR=<env>/cli-state <env>/bin/patchy …`.

## Not built yet

`pnpm dev transcript` (#792) shows a CLI script's output before and after, and
`trial` (#793) a fresh agent trying a task. Each adds its entry here when it
lands.

## Publishing

- `gh pr create`, `gh pr edit` and `gh pr comment` take `--attach <file>`, once
  per file. Each `![alt](./after.png)` in the body that names an attached file
  becomes its upload, inside tables and `<details>` too. It needs gh 2.102 or
  later (`gh --version`).
- An attached `![name](x.mp4)` alone in its own paragraph, with blank lines
  around it, plays inline; sharing a paragraph, it becomes a link.
- At most 50 attachments per command and 10 MB per file.
- `compare` and `film` with `--pr` keep each section between
  `<!-- patchy-dev:<command>:<key> -->` markers. A re-run replaces its own
  section wherever it was moved and leaves the rest of the body alone. When
  some uploads fail, gh still updates the body; the command names the files
  left as local paths and exits 1, and running it again replaces the section.
- Uploads are public by URL, and so is the repo: only scenario data, never
  tokens.
- Re-run after a push that changes what the evidence shows. Editing the body
  doesn't re-run CI.
