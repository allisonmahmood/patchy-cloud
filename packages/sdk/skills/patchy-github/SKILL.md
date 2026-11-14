---
name: patchy-github
description: Add a company's GitHub repositories to a patch: a set of repositories on one GitHub account, read-only.
---

# Company repositories on GitHub

Read `../patchy-loop/SKILL.md` first. A GitHub connection is a set of repositories on one GitHub account that an admin connected through Patchy's GitHub App, ticking repositories GitHub showed them administering. Patchy holds the App's key and mints every token itself, so no token reaches config, source, transcripts or patch code, and nothing a patch does can change GitHub. Anyone who can open a patch that declares the connection reads what the connection reaches, whatever their own access on GitHub.

Connections are tier 2's: a tier 1 page reaches only its own patch, so declaring GitHub on a tier 1 repo is refused with `tier_mismatch`; move the repo to tier 2 first, as `../patchy-loop/SKILL.md` says.

## Declare repositories

1. Run `pnpm patchy list connections` and choose a connected `github/<handle>` by description. `pnpm patchy list connections github/<handle>` shows the account and its repositories. An admin connects GitHub at `/settings/integrations`; ask them there rather than for a token.
2. Run `pnpm patchy add github/<handle> --as repos`. It inserts `repos: { kind: "github", handle }` into `uses` and generates the client, the context and this skill.
3. Read `patchy/_generated/index.json`, then the context for `repos`: the account and each repository with its default branch, and whether it is private, archived or has left the installation.

A connection reaches its current set of repositories, which an admin changes on the connection's page: one added later is reachable without `patchy refresh`, and one removed or gone from the installation is refused.

The operations patch code calls arrive in a later release; until then a GitHub declaration reads nothing.
