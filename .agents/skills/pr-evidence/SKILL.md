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

## Screenshots: `pnpm dev shot`

- **Shows** a page as one person sees it, patch frames included, with the
  final URL, the HTTP status and every browser error.
- **Make** it with `pnpm dev shot <person> <path> --out <file>`, a full-page
  PNG; `<person>` is an email, or a scenario person's key or first name. Read
  the PNG before publishing it. Before and after takes two instances, one at
  the base commit and one at the head.
- **Costs** about two minutes a side for a fresh checkout: a minute or so to
  install, under half a minute for `pnpm dev up team` (`brightline` takes about
  a minute), then two seconds a shot.
- **Gotchas.** `shot` captures the worktree's own instance, which can hold the
  developer's data and uncommitted code. Until #725 lands, publish only from a
  separate throwaway checkout and instance, seeded with scenario data at the
  intended commit. Don't reset the developer's instance to produce evidence.
  One way, with `scenarios/README.md` listing the scenarios:

  ```sh
  git worktree add --detach /tmp/<name> <commit>
  cd /tmp/<name>
  pnpm install --frozen-lockfile && pnpm dev up <scenario>
  pnpm dev shot <person> <path> --out /tmp/<pr-folder>/after.png
  pnpm dev down && cd - && git worktree remove --force /tmp/<name>
  ```

  The checkout's folder name becomes the instance's host, which pages can show.

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
  fenced block, with `echo $?` after it where the exit code matters. In the
  throwaway checkout above,
  `env -u PATCHY_API_URL -u PATCHY_API_TOKEN pnpm patchy …` runs the CLI from
  source against that checkout's instance (the `patchy-dev-loop` skill),
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

`pnpm dev compare` and `film` (#725) show pages and flows before and after from
throwaway evidence instances, `transcript` (#792) a CLI script's output, and
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
- Uploads are public by URL, and so is the repo: only scenario data, never
  tokens.
- Re-run after a push that changes what the evidence shows. Editing the body
  doesn't re-run CI.
