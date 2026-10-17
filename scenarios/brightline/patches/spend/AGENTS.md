# Purpose

Request, approve and track studio and client-project spend, with receipts attached and approval rules that can't be bypassed.

The purpose above is independent of the published description in `patchy.json`.

# Working here

Installation already ran. Do not reinstall to start building. Run `pnpm patchy --help` for commands. Read the release-bound `.agents/skills/patchy-loop/SKILL.md` for how to exercise the tier configured in `patchy.config.ts`.

- `patchy.json`: instance, optional patch id, published description and its sync stamp. Edit the description here; cloud edits pull down at refresh, dev start and publish.
- `patchy.config.ts`: the tier, owned tables and file stores with their descriptions, and declared connections/shared tables/shared stores.
- `src/`, `index.html`: the page UI. Browser code runs at tier 1 or above; `vite.config.ts` builds one HTML file. Tier 1 calls declared resources directly; tier 2 calls generated `patchy.server.*` handlers.
- `server/`: hosted handlers when tier 2 is declared. Import bound builders from `patchy/_generated/server.ts`. Keep server implementation out of the page; page imports from here must be type-only.
- `helpers/`: company-owned code shared by the page or server. Keep each helper's imports compatible with where it runs.
- `fixtures/`: invented local rows and files, never production data.
- `patchy/_generated/index.json`: generated index linking every declaration, revision, context and skill. Never edit generated files.
- `.agents/skills/patchy-loop/SKILL.md`: the local build loop and moving tiers.
- On tiers 1 and 2, read `.agents/skills/patchy-preact/SKILL.md` before building a Preact page.
- On tier 2, read `.agents/skills/patchy-server/SKILL.md` before writing handlers.
- `.agents/skills/patchy-tables/SKILL.md`: owned tables.
- `.agents/skills/patchy-files/SKILL.md`: owned files.
- Read declaration skills when using their resources: `.agents/skills/patchy-postgres/SKILL.md`, `.agents/skills/patchy-shared-tables/SKILL.md`, or `.agents/skills/patchy-shared-stores/SKILL.md`.

Run `pnpm typecheck` and, when `package.json` declares it, `pnpm lint` before publishing. Run `pnpm patchy refresh` after editing declarations, changing tier or adding, removing or renaming server modules. Refresh never edits `src/`, `server/` or `helpers/`. Deleting `.patchy/` destroys local rows and files.

# Agent area

`server/agent.ts` is the agent area: its exports, and nothing else, are the tools people's own agents call through Patchy's MCP, acting as the person. Each needs a `description` and described arguments, and exchanges JSON only. Agents get `myRequests` and `draftRequest`, and spending stays a human act: a draft lands in `drafts` and waits on the page (`src/Drafts.tsx`) until its person finishes it in the New request dialog, which submits through `requests.submit` and deletes the draft, or discards it (`server/drafts.ts`). Receipts are uploads, which agent tools can't carry, and approve, reject and mark paid deliberately have no agent tools.
