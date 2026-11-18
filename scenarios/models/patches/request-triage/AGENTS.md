# Request triage

A throwaway prototype patch for model roles (tier 2). `server/triage.ts` holds the actions: `run` calls the `decisions` role's `decide` and the `writer` role's `generate`, then writes a row; `failure` calls a role mapped to a failing fake model and lets the refusal reach the page. The roles are the `models` scenario's; read `.agents/skills/patchy-models/SKILL.md`.
