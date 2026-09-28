# Skill wiring

How the global `patchy` skill and release-bound project skills reach agents.

`skills/patchy/SKILL.md` and its `references/` directory are the authoritative **global skill** bundle: the entry door for sign-in, static-file publishing and `patchy init`. Inside a patch repo the project skills govern building. The checkout links `.claude/skills/patchy` → `.agents/skills/patchy` → `skills/patchy`, so edits through either agent path reach the same source. Edit that source, not a generated package copy.

The package build (`scripts/build-patchy-package.mjs`) copies `skills/` wholesale to `packages/patchy/skills/`. The package's `files` list includes that directory; the packed `patchy` package therefore carries the publishing skill and its onboarding, welcome-page and style references beside the executable. Both `build` and `prepack` regenerate this copy.

The checked-in root `skills-lock.json` uses the `skills` CLI's lockfile format for the repo's own wiring. Its `patchy` entry names `skills/patchy/SKILL.md`; `computedHash` is the SHA-256 of that file's bytes alone (`sha256sum skills/patchy/SKILL.md`), not a hash of the references or the generated copy. Refresh it by hand after the final `SKILL.md` edit. Neither the build nor CI verifies that hash.

Internal skills stay under `.agents/skills/`, outside the copied `skills/` tree, and carry `metadata.internal`: the local-instance loop `patchy-dev-loop`, and the `/code-review` review specs `effect-service-conventions` and `ui-consistency`.

The package is private and not published to a registry. `pnpm --filter patchy build`
packs `packages/patchy/artifacts/patchy-<release>-<digest>.tgz`, where `digest` is
the lowercase SHA-256 of the archive bytes. The SDK build copies every retained
digest archive into `packages/sdk/artifacts/` without deleting earlier destination
archives. Each build task owns its cached outputs. `release.json` identifies the
current archive, its SHA-512 integrity, and its tested and accepted toolchain versions.
`GET /api/release` reports that archive's exact URL and integrity; the
unauthenticated tarball route is immutable. A same-version rebuild with different
bytes gets a different URL, which `refresh` writes into the managed `patchy` pin.
After installation, the global skill lives at `node_modules/patchy/skills/patchy/SKILL.md`.

Before serving discovery, the server validates the current archive's SHA-256 and
SHA-512 against the metadata and persists all packaged digest archives under
`sdk/` in its ContentStore. Downloads read that store and verify the filename's
digest before returning bytes. Historical downloads do not depend on archives
remaining in a later deployment image. All replicas must share the durable store;
filesystem deployments must retain `PATCHY_STORAGE_DIR` across restarts and
upgrades. Back up and migrate its `sdk/` objects along with patch content, and do
not apply expiry or deletion rules to them. Losing that store loses the retention
guarantee. Build caches and copies preserve local history but do not replace
durable storage.

Bundling a skill and wiring it into this checkout do not publish it to a skill
directory or start onboarding; onboarding runs only when the user asks.

## Project skills

`packages/sdk/skills/<name>/SKILL.md` is the sole source for the five project
skills. The SDK's authenticated `POST /api/sdk/generate` serves their contents
with the requested current release, alongside the generated client and declaration
context. They are not hand-copied into patch projects or sourced from the global
skill's package copy.

- Core, installed by `init`: `patchy-loop`, `patchy-tables`, `patchy-files`.
- Declaration-driven: `patchy-postgres`, `patchy-shared-tables`.

The CLI writes them under `.agents/skills/patchy-*/` in the patch repo and lists
their paths in `patchy/_generated/index.json`. `AGENTS.md` points agents at those
skills and the index; `CLAUDE.md` imports `AGENTS.md`.

Presence is sticky: `refresh` re-fetches every present skill and adds any implied
by the config, never deleting one on its own. A present skill no longer offered
by the release fails refresh rather than silently retaining stale instructions.
`remove` may remove a declaration's skill when no declaration of that kind remains.
Edit canonical SDK sources here; in a patch repo change definitions or declarations
and run `pnpm patchy refresh`, never edit managed skill copies.
