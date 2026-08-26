# Skill wiring

How the `patchy` agent skill (`skills/patchy/SKILL.md`) reaches agents working inside this repo.

`.claude/skills/patchy` → `.agents/skills/patchy` → `skills/patchy` symlinks single-source the skill, so there is only ever one copy of `SKILL.md`. The checked-in root `skills-lock.json` pins it without a second copy. Note the file plays two roles: it is the `skills` CLI's lockfile format, used here as the repo's own self-wiring mechanism. Its `computedHash` is `sha256` of `skills/patchy/SKILL.md` (`sha256sum skills/patchy/SKILL.md`), refreshed by hand when that file changes — nothing in CI verifies it.

The operator-only skill at `.agents/skills/patchy-mint-token` sits outside `skills/` and carries `metadata.internal`.

Public distribution of the page-publishing skill is upstream PatchPage's business, not this repo's — nothing here is published to a skill directory or a package registry.
