# Skill wiring

How the `patchy` agent skill reaches agents in this checkout and in the packed CLI.

`skills/patchy/SKILL.md` and its `references/` directory are the authoritative bundle. The checkout links `.claude/skills/patchy` → `.agents/skills/patchy` → `skills/patchy`, so edits through either agent path reach the same source. Edit that source, not a generated package copy.

The CLI build (`scripts/build-cli-bundle.mjs`) copies `skills/` wholesale to `packages/cli/skills/`. The package's `files` list includes that directory; the packed CLI therefore carries the publishing skill and its onboarding, welcome-page and style references beside the executable. Both `build` and `prepack` regenerate this copy.

The checked-in root `skills-lock.json` uses the `skills` CLI's lockfile format for the repo's own wiring. Its `patchy` entry names `skills/patchy/SKILL.md`; `computedHash` is the SHA-256 of that file's bytes alone (`sha256sum skills/patchy/SKILL.md`), not a hash of the references or the generated copy. Refresh it by hand after the final `SKILL.md` edit. Neither the build nor CI verifies that hash.

Internal skills stay under `.agents/skills/`, outside the copied `skills/` tree, and carry `metadata.internal`: the local-instance loop `patchy-dev-loop`, and the `/code-review` review specs `effect-service-conventions` and `ui-consistency`.

The bundled recipe covers device-login handoff and completion, company-default publishing and explicit public sharing, machine logout and revocation, and reading company patches through the user's signed-in browser. Only public patches fetch directly by URL; the publishing key is never a browser credential. Keep the skill and onboarding reference aligned with `packages/cli/README.md` and ADR-0004, and announce the sharing scope returned by upload or share.

The CLI package is private and not published to a registry. Bundling a skill and wiring it into this checkout do not publish it to a skill directory or start onboarding; onboarding runs only when the user asks.
