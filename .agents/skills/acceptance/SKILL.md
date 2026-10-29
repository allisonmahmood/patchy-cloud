---
name: acceptance
description: "Acceptance for a pull request: check a PR you didn't write on throwaway instances at its head commit, then post the verdict, PASS, PASS with notes or FAIL, with its evidence. Use when asked for acceptance or a verdict on a PR, including getting one for your own."
metadata:
  internal: "true"
---

# Acceptance

You check a pull request someone else wrote, on throwaway instances at its head
commit, and post one **verdict**. The author's tests prove what the author
thought to test; you look for what Done means asks and what the diff puts at
risk beyond it. You report, the author fixes and Allison merges: leave the PR's
code, branch, body and labels as they are, and never merge.

If you wrote the change, say so and stop: a verdict needs another agent. To get
one for your own PR, see [Asking for a verdict](#asking-for-a-verdict).

## 1. Read the PR

- `gh pr view <n> --json title,body,headRefOid,baseRefName,labels,files,closingIssuesReferences`.
  `headRefOid` is the **head**, the commit your verdict names.
- The issue it closes, `gh issue view <issue>`: its **Done means** is what the
  PR must show. Without an issue or a Done means, the PR's What changed is the
  claim to check.
- `gh pr diff <n>`, the review comments and reviews
  (`gh pr view <n> --comments`, `gh api repos/{owner}/{repo}/pulls/<n>/reviews`
  and `/pulls/<n>/comments`), and `gh pr checks <n>`.
- **Release impact.** Test the two rollback answers against the diff. A revert
  can leave behind schema (a capability's `src/migrations.ts`), rows in a new
  shape, deleted data, mail sent, changed infrastructure (`apps/infra`), or a
  contract the CLI, the shell or people's agents now rely on (`packages/api`,
  CLI flags and `--json`). When the release before couldn't work with what the
  revert leaves, the PR needs the `one-way` label. On a PR that changes a
  migration, the `rollback-rehearsal` check rehearsed it: read its result.

Done when you can say in a few sentences what the PR claims, what Done means
asks, what the diff could break beyond both, and which golden journeys below it
could touch.

## 2. Get the head

Work in a checkout made for this run: a T3 worktree task's own, a folder the
person made for it, or one you make. Any other checkout holds someone's work and
instance. The evidence commands compare its `HEAD` with where it left
`origin/main`, and `pnpm dev down` there deletes only what this run made.

```sh
git fetch origin <baseRefName> "pull/<n>/head"
git checkout --detach <head sha> && pnpm install          # in a checkout made for this run
git worktree add --detach <dir> <head sha> && cd <dir> && pnpm install   # or make one
```

Done when `git rev-parse HEAD` prints the head and `git status --short` prints
nothing.

## 3. Check

Check each Done means line, the risks you named in step 1 and every golden
journey the change could touch. How is your call. These are the tools:

- **The evidence commands** in the `pr-evidence` skill: `compare` for pages,
  `film` for a flow (`--after-only` films the head alone), `transcript` for CLI
  lines, `trial` for a fresh agent's attempt. Each brings up throwaway
  evidence instances at both commits on fresh scenario data and takes them
  down. Run them without `--pr`, which would write into the author's PR body:
  each writes its section and files under `.local/shots/<run>/`, ready for your
  verdict. For a PR stacked on another branch, `--base origin/<baseRefName>`
  makes that branch, as step 2 fetched it, the before.
- **Tests:** CI's checks on the head, a suite you run in your checkout, or a
  test the PR added, red on the base and green on the head (`pr-evidence` has
  the recipe).
- **Direct checks** on an instance of your checkout: `pnpm dev up <scenario>`
  brings one up at the head on fresh scenario data. Drive it as the
  `patchy-dev-loop` skill says: `curl` as a person, or `pnpm dev shot`. Run
  the environment's CLI only as
  `env -u PATCHY_API_URL -u PATCHY_API_TOKEN PATCHY_STATE_DIR=<env>/cli-state <env>/bin/patchy …`,
  since an exported URL or token steers it to another instance, production
  included.

Evidence instances are heavy: run one command at a time, and take each instance
you start down when you're done with it.

A check you couldn't run, such as one needing Clerk, a missing prerequisite or
a scenario that wouldn't come up, is **not run**, with the reason. It never
counts as passed.

Done when every Done means line, every risk and every touched journey has a
result: passed, failed or not run, each with its evidence or its reason.

## 4. Decide

- **PASS:** Done means holds, nothing you checked broke, and the rollback
  answers match the diff.
- **PASS with notes:** the same, with something the author or Allison should
  know: a check not run, a gap in the PR's own evidence, a risk outside Done
  means, a nit.
- **FAIL:** a Done means line doesn't hold, a journey or anything else you
  checked broke, or the rollback answers miss what a revert leaves behind,
  including a missing `one-way` label.

A red check on the head is a fact to report. Count it toward FAIL when the
failure is the change's, not a known flake (open issues labelled `flaky`).

## 5. Post the verdict

The repo and its uploads are public by URL. A verdict carries only scenario
data from instances at the PR's commits. Read every file before attaching it,
and trim command output to what makes the point, without home paths, tokens,
ids or infrastructure details.

Write the comment to `.local/shots/verdict.md`, which git ignores, starting
with the marker line:

```markdown
<!-- patchy-acceptance -->

## Acceptance: <PASS | PASS with notes | FAIL>

Checked `<head sha>` (base `<base sha>`) on `<scenario>`, by <model> in <harness>.

**Done means**

- <line>: <passed | failed>. <evidence>

**Golden journeys**

- <journey>: <passed | failed>. <evidence>

**Rollback answers:** <they match the diff, or what a revert leaves that they miss>

**Not run**

- <check>: <why>

**Notes**

- <for PASS with notes, each note; for FAIL, what fails and its evidence>
```

The comment is signed by that model and harness alone, not by a personal agent
name your instructions may give you.

Put the evidence inline: an evidence command's section from its `.md` file,
test output, a few lines of a transcript. A long one folds into `<details>`, so
the verdict still reads at a glance. Then post it and replace your earlier
verdict:

```sh
me=$(gh api user --jq .login)
old=$(gh api "repos/{owner}/{repo}/issues/<n>/comments" --paginate \
  --jq '.[] | select(.body | startswith("<!-- patchy-acceptance -->")) | "\(.id) \(.user.login)"' |
  awk -v me="$me" '$2 == me { print $1 }')
gh pr comment <n> --body-file .local/shots/verdict.md --attach .local/shots/<run>/<file> &&   # one --attach per file
  for id in $old; do gh api -X DELETE "repos/{owner}/{repo}/issues/comments/$id"; done
```

Only verdicts posted by your GitHub account are yours to replace, and they go
only once the new one is up: `gh` uploads attachments only into a comment it
creates, and a new comment notifies the people watching the PR.

Before posting, check `headRefOid` again. If the head moved while you worked,
post anyway and say so in the first line: the verdict names the commit you
checked, and the new head needs a new run.

Told not to post, or checking a commit without a PR, print the verdict instead.

Then clean up: `pnpm dev down` in your checkout, and `git worktree remove <dir>`
for a checkout you made.

Done when the PR has exactly one marked comment from your account, it names the
head you checked, and you have reported the verdict to whoever asked.

## Golden journeys

What must keep working for the people using Patchy. Each journey names its
scenario (`scenarios/README.md`), its people, what working looks like and its
way back. A PR that adds a journey people rely on adds its entry here.

- **Sign in.** `team`, Ben. Signed out, a company page answers 401 with the
  sign-in door, and signing in returns to that page. Back: sign out, and the
  door returns.
- **Log a machine in.** `team`, Ada. `patchy login` prints a URL and a code;
  Ada confirms the code in the browser, and `patchy whoami` then names the
  machine. Back: `patchy logout`, or revoke it on Your agents.
- **Publish a page.** `team`, Ada and Ben. Ada's CLI publishes an HTML file;
  Ben opens it at its address and on Home. Back: `patchy retire` or
  `delete --yes` takes it off its address, and `restore` brings it back there.
- **Share and unshare.** `brightline`, Allison and a signed-out reader. After
  `patchy share … public`, `harbor-pine-kickoff`'s current version answers 200
  without a session. Back: `share … company`, and the door returns.
- **Find and open a tool.** `brightline`, Jordan. Home lists the studio's
  patches, a search finds Kudos, and it opens in its frame.
- **Use a tool live.** `brightline`, Jordan and Priya. Jordan gives kudos
  (tier 2); it appears on Priya's open page without a reload.
- **Use a tier 2 tool.** `brightline`, Jordan and Allison. New Business opens
  with its sample deals, and a deal Jordan moves to another stage moves on
  Allison's open board. Spend refuses anyone approving their own request.
  Back: move the deal back.
- **Invite and join.** `team`, Ada and a new address. Ada invites it from
  `/company`; the person signs in, chooses Join on Acme Co and lands on Home.
  Back: revoke a pending invite; deactivate a member, then reactivate.

## Asking for a verdict

For the author, once the PR is up and pushed. Start an agent that didn't write
the change, preferably another model family, and give it the PR number and this
skill. Each new head commit needs a new run. Any harness works, for example:

- T3 Code: `delegate_task` to a Codex model with `isolation: "worktree"`, which
  starts the child in its own checkout at your local commit.
- `codex exec` or `claude -p`, started in a fresh checkout at the head.
- A person asking any agent: "Follow `.agents/skills/acceptance/SKILL.md` for
  PR #<n>."

Keep it apart from code review: an acceptance run checks behaviour on fresh
instances and posts one verdict, and a review reads the code.
