# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Also apply an area label

Triage sets one more axis: **which part of the codebase the issue touches**. Apply every area label that fits — an issue can legitimately span several. If the report doesn't say enough to tell, leave them off rather than guessing; a wrong area label is worse than none, because it's what `gh issue list --label area:cli` is filtered on.

| Label               | Covers                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `area:server`       | `apps/server` and the hosting-side packages: `analytics`, `api`, `auth`, `companies`, `company-database`, `content-store`, `limits`, `patches`, `runtime`, `sdk`, `serving`, `sql`                              |
| `area:primitives`   | `packages/primitives` — patch tables and files                                                                                                                                                                  |
| `area:integrations` | `packages/integrations` — company connections and integration implementations                                                                                                                                   |
| `area:ui`           | `packages/portal`, shared HTML and patch-presentation helpers in Core, page rendering and handlers in Auth and Integrations, and first-party rendering and address notices in Serving                           |
| `area:cli`          | `packages/patchy` — the `patchy` package — and the `skills/` it ships                                                                                                                                           |
| `area:core`         | `packages/core` — the safe-HTML policy, ids, crypto                                                                                                                                                             |
| `area:ci`           | `.github/`, `scripts/`, shared `test/` infrastructure, `eslint/`, dependency `patches/`, and root-level workspace, test, tool-version and file-handling config. Lockfile changes alone do not apply this label. |
| `area:docs`         | `docs/`, `examples/`, README, and other Markdown                                                                                                                                                                |

This table and the globs in `.github/labeler.yml` are meant to say the same thing. If you change one, change the other.

Primitives, Integrations and Portal have their own areas rather than automatically receiving `area:server`. A change to their server wiring receives both. UI overlaps the other areas where first-party pages live outside Portal: a connection-page change receives `area:ui` and `area:integrations`. Package-local tests keep their package's area; shared testing infrastructure receives `area:ci`.

The bug and feature forms ask the reporter which part of Patchy Cloud is affected. Treat that answer as a hint, not a decision: reporters routinely attribute a validation bug to the CLI when it comes from `packages/core`.

Two things triage should **not** do here:

- **Don't set `size:*` labels.** They're derived from a pull request's diff by `.github/workflows/pr-labels.yml` and mean nothing on an issue.
- **Don't add a "blocked" label.** This repo records blocking through GitHub's native issue dependencies, which is what the wayfinding operations in `issue-tracker.md` already use.

## PR size labels

The workflow applies exactly one size label from additions plus deletions, excluding lockfiles, build output, minified assets and snapshots. Tests and documentation count toward size.

| Label     | Changed lines |
| --------- | ------------- |
| `size:s`  | Under 100     |
| `size:m`  | 100–500       |
| `size:l`  | 501–1,000     |
| `size:xl` | Over 1,000    |

Above 1,000 lines, review needs a different approach from reading the entire PR in one pass. Size labels describe review scope; they do not block merging or require splitting a PR.
