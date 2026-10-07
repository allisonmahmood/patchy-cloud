<!-- PROTOTYPE for #563 -->

# Company look (prototype)

Throwaway build for [#563](https://github.com/allisonmahmood/patchy-cloud/issues/563), step 1 of [#547](https://github.com/allisonmahmood/patchy-cloud/issues/547). Never merged.

**The question:** are about a dozen fixed tokens, plain-element styles and a brief enough for a fresh agent to build a tool that reads as the company? Before the build tickets lock the token names, it also checks the publish checks against real brands, fonts, re-skinning, the override path and the no-look fallback.

**How:** four agents captured looks by following a draft capture reference (`capture.md`). Six fresh agents built the same tier 1 spend-request tracker from the same prompt (`runs/TASK.md`): one per look, one with no look, and a Halloween page in a repo carrying Vanguard's look. Every look-built tool was then restarted under every other look, with no code change.

## What is where

| Where                                                                                     | What                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture.md`                                                                              | The draft global-skill reference: what a look is, the 13 tokens, `look.css` rules, the `LOOK.md` outline, how to capture, the publish checks. The thing under test.                                                                                                                       |
| `patchy-look-skill.md`                                                                    | The generated `patchy-look` project skill: precedence, how to use the look, the token table, then the brief.                                                                                                                                                                              |
| `looks/<name>/`                                                                           | `look.css`, `LOOK.md`, a placeholder `logo.svg` and the capturing agent's `notes.md` for Linear, Duolingo, Vanguard (`finance`) and the Patchy look. No brand fonts or real logos.                                                                                                        |
| `checks.json`                                                                             | `scripts/check.mjs` over every look: the draft `look publish` checks plus extra contrast pairs.                                                                                                                                                                                           |
| `specimen/specimen.html`                                                                  | The specimen page. Patchy owns it and a look styles it.                                                                                                                                                                                                                                   |
| `runs/`                                                                                   | `TASK.md`, `TASK-halloween.md`, `run.sh` for new tools, `TASK-extend.md`, `TASK-restyle.md` and `revise.sh` for changing a finished tool after a new look revision, each run's sources and `REPORT.md` (no `node_modules`, local data or generated files), and `measurements.json`.       |
| `shots/`                                                                                  | Specimens, tools (empty and loaded), the 12 re-skins and the font comparison, as WebP.                                                                                                                                                                                                    |
| `comparison.html`                                                                         | The side-by-side page, built by `scripts/comparison.mjs`.                                                                                                                                                                                                                                 |
| `packages/patchy/src/prototypeLook.ts` and hooks in `ManagedProject.ts`, `initProject.ts` | Stands in for look generation. With `PATCHY_PROTOTYPE_LOOK=<look folder>`, init, refresh and dev start write `patchy/_generated/look.css`, `patchy/_generated/logo.svg` and `.agents/skills/patchy-look/SKILL.md`. Init's scaffold imports the look, and `AGENTS.md` points at the skill. |

## Try it

```sh
pnpm install
pnpm dev up team                                   # prints the environment folder
export PATCHY_DEV_ENV=<that folder>

node prototypes/company-look/scripts/check.mjs     # the publish checks over every look
node prototypes/company-look/scripts/specimen.mjs  # .local/company-look/specimen-<look>.png
node prototypes/company-look/scripts/comparison.mjs   # .local/company-look/comparison.html

# a fresh agent building the tool in a look (or "none")
prototypes/company-look/runs/run.sh spend-linear linear TASK.md "Spend requests"

# open any repo in a look, or switch its look as a new revision would
export PATH=$PATCHY_DEV_ENV/bin:$PATH PATCHY_STATE_DIR=$PATCHY_DEV_ENV/cli-state
PATCHY_PROTOTYPE_LOOK=$PWD/prototypes/company-look/looks/duolingo \
  node prototypes/company-look/scripts/shoot-run.mjs /tmp/look-563/ws/spend-linear /tmp/linear-as-duolingo
```

Run agents from a folder outside `$HOME`. Claude Code loads `~/.claude/CLAUDE.md` as an ancestor file from anywhere beneath it, even with `--setting-sources project`, and that includes the `pnpm dev up` agent workspace.

## What it found (measured 2026-10-06/07, one Linux laptop)

- **The tools read as their company.** All four agents found the look only through the `AGENTS.md` line. Each read the `patchy-look` skill before writing CSS, read `look.css` so it didn't restyle plain elements, used the logo and never edited generated files. They lifted the brief's component recipes nearly verbatim. Builds took 3.5 to 5 minutes and $1.23 to $1.53, with 85 to 100 token references each. The only colour literals are status colours: 0 to 5 per tool.
- **The control is generic.** With no look, the agent found the global skill's plan-doc style in `node_modules/patchy` and rebuilt it by hand: 672 lines of CSS, 21 colour literals and 25 custom properties of its own.
- **Overrides work.** In the Halloween run the agent removed the look import, left generated files alone and said once that the page is styled for Halloween rather than the company look.
- **Re-skins follow, mostly.** Colours, fonts, radius, the logo and light or dark follow in 12 of 12 swaps; structure and voice don't. Two things broke. Literal status colours stayed light on a dark look. And Linear's 4px spacing unit (the others use 8px) made its tool about 50% taller under any other look.
- **Changing an existing tool after a revision.** Two fresh agents worked on copies of the Linear tool after Duolingo's look arrived as a new revision.
  - Asked to add features, the agent kept the tool's own style, as the precedence rule says. It also had to reset Duolingo's plain-button lip and uppercase, which had leaked onto the tool's own tab and ghost buttons.
  - Told "update this tool to our current company look", the agent rebuilt it in Duolingo's style in about 4 minutes.
- **Astra's review** (GPT-6 Astra, a different model family) tightened the token definitions, the contrast rule and the "no look" state. It listed what the build tickets still have to test; the comparison page carries both.
- **Token gaps, from the captures and the runs.**
  - All four captures and three of four tools wanted status colours.
  - All four captures set `--look-link` apart from `--look-accent`.
  - Three of four brands don't use the accent for the primary button: Vanguard's are black, linear.app's is off-white, and Duolingo splits green and blue.
  - Single values strain in places: one radius can't hold pill buttons with square inputs, and one border can't be both a faint hairline and an input outline. Two looks are dark-capable brands with no slot for a theme.
- **Contrast.** All four looks pass the four required pairs at real or lightly adjusted brand values. Duolingo needed dark text on its green (white is 2.09:1) and a darker link blue. Measured but not required: danger on bg (Duolingo 4.30) and muted on surface (Duolingo 4.24, Vanguard 4.21).
- **Sizes.** `look.css` is 3.3 to 4.9 KB, `LOOK.md` 10.2 to 12.1 KB and the logo 0.4 to 0.6 KB. Three full Inter weights embedded as `data:` fonts made `look.css` 418 KB, and they loaded in the tier 1 frame.
- **Capturing.** Each capture took 8 to 14 minutes, with no bot blocks at Linear, Duolingo or Vanguard. Single-page apps need computed styles or a search of the JS bundles. Consumer and bank apps sit behind a login, so the sign-in and help pages stand in.
