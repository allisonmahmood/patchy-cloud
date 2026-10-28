---
name: patchy-attio
description: Add a company's Attio workspace to a patch and read its CRM objects, lists and members.
---

# Company CRM on Attio

Read `../patchy-loop/SKILL.md` first. An Attio connection is one Attio workspace that an admin connected with a read-only access token. Patchy holds the token and writes every request, so nothing a patch does can change Attio, and the token stays out of config, source and transcripts. The token acts for the workspace, not a person: anyone who can open a patch that declares the connection reads what the token reads, and Attio's own member permissions don't carry over.

## Declare a workspace

1. Run `pnpm patchy list connections` and choose a connected `attio/<handle>` by description. `pnpm patchy list connections attio/<handle>` shows the workspace and its objects and lists. An admin connects workspaces at `/company/connections`; ask them there rather than for a token.
2. Run `pnpm patchy add attio/<handle> --as crm`. It inserts `crm: { kind: "attio", handle }` into `uses` and generates the client, the context and this skill.
3. Read `patchy/_generated/index.json`, then the context for `crm`: the workspace's objects and lists, each attribute's slug, title and type, and the options of each select and status.

There is no fixture: CRM rows invented for a fixture never resemble a company's.
