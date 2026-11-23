# Purpose

Juniper's request triage: a pasted support request routed to a team and rated for urgency by the company's decision role, with a line about it and a typed reply plan from its text role, in one action.

The purpose above is independent of the published description in `patchy.json`.

# Working here

Installation already ran. Do not reinstall to start building. Run `pnpm patchy --help` for commands. Read the release-bound `.agents/skills/patchy-loop/SKILL.md` for how to exercise the tier configured in `patchy.config.ts`.

- `patchy.config.ts`: the tier and the two model roles this patch declares.
- `server/triage.ts`: the action that calls both roles. Model calls run only in actions.
- `src/`, `index.html`: the page, which calls the action and shows what came back, or how the call ended.
- `patchy/_generated/index.json`: the generated index, each role with its kind. Never edit generated files.

`patchy dev` can't call model roles yet: publish to try a change. Run `pnpm typecheck` before publishing, and `pnpm patchy refresh` after editing declarations.
