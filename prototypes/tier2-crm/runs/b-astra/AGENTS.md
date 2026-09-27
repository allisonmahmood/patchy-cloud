# Purpose

A small CRM for the team: contacts, companies and deals, with a deal pipeline, attachments, company contracts and a finance report.

The purpose above is independent of the published description in `patchy.json`.

# Working here

Installation already ran. Do not reinstall to start building. Run `pnpm patchy --help` for commands; test with `patchy dev` (`pnpm patchy dev` from this repo).

- `patchy.json`: instance, optional patch id, published description and its sync stamp. Edit the description here; cloud edits pull down at refresh, dev start and publish.
- `patchy.config.ts`: owned tables and file stores with their descriptions, and declared connections/shared tables.
- `src/main.tsx`, `src/App.tsx`, `index.html`: the browser UI (Preact with compat semantics through `patchy/preact`; read `.agents/skills/patchy-preact/SKILL.md`); `vite.config.ts` builds one HTML file.
- `server/*.ts`: the handlers (queries, mutations, actions) the browser calls through `patchy.server.<file>.<export>`; they run on Patchy's engine, never in the browser. Read `.agents/skills/patchy-server/SKILL.md` first.
- `fixtures/`: local rows only, never production data.
- `patchy/_generated/index.json`: generated index linking every declaration, revision, context and skill. Never edit generated files.
- `.agents/skills/patchy-loop/SKILL.md`: the local build loop.
- `.agents/skills/patchy-tables/SKILL.md`: owned tables.
- `.agents/skills/patchy-files/SKILL.md`: owned files.
- `.agents/skills/patchy-server/SKILL.md`: server handlers, their context, errors and the import rule.
- Integration skills appear under `.agents/skills/patchy-postgres/SKILL.md`, `.agents/skills/patchy-shared-tables/SKILL.md` and `.agents/skills/patchy-shared-stores/SKILL.md` when declared.

Run `pnpm patchy refresh` after editing declarations. Deleting `.patchy/` destroys local rows and files.
