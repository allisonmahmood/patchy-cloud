---
name: patchy-loop
description: Build in a Patchy repo, refresh generated files, choose declarations from the catalog, or diagnose release and local-development boundaries. Read before changing patch code.
---

# Build in a patch repo

## Start with the repo

1. Read `AGENTS.md` for the purpose and layout, then `patchy/_generated/README.md` and `patchy/_generated/index.json` for available skills, declarations, context paths and revision stamps. Initialization already installed dependencies: use the pinned `pnpm patchy` command, not a global copy, and do not reinstall as a setup ritual. `pnpm patchy --help` lists commands in this release.
2. Read `patchy.config.ts`. It defines owned tables and file stores and declares connections and shared tables in `uses`. Read `../patchy-tables/SKILL.md` for rows, `../patchy-files/SKILL.md` for bytes, and the declaration's skill and generated context before using it. Import the generated client from `patchy/_generated/client.ts`; in `src/main.ts`, use `import { patchy } from "../patchy/_generated/client.js"`.
3. Edit source, config and invented fixtures. Run `pnpm patchy refresh` after changing definitions or declarations. The generated index must name every declaration and its context before you use it. Run `pnpm typecheck`; repair source or config, never generated output.
4. Run `pnpm patchy dev --json`. Open its `url` and exercise an insert and a list through the actual local shell; inspect file and declaration behavior when used. The command returns only when healthy and is idempotent. Code rebuilds reload the whole shell at its current route. After config or fixture changes, stop and start dev again. A standalone Vite preview cannot exercise declared capabilities.
5. When asked to publish, run `pnpm patchy publish` from the repo root. It recovers any saved attempt first; otherwise checks the release, executes config, verifies declaration stamps, typechecks and builds a single HTML bundle. Fix `stale_generated` with `pnpm patchy refresh`, build errors in source, and `not_additive` using the reported object/change/fix. Report the address, scope, tier, version, provisioned and unused resources.

## Commands and ownership

- `pnpm patchy catalog` shows connected company connections and shared tables you can open, with copy-ready `add` and `uses` lines. `--all` also shows offered integrations and their state. A catalog entry grants no extra access.
- `pnpm patchy add postgres/warehouse --as sales` or `pnpm patchy add shared-table <patchId>/<table> --as contacts` edits `uses` and generates its client, context, fixture stub and skill. Choose actual names from the catalog. Connection setup belongs to an admin at `/company/connections`; keep credentials out of the repo and transcript.
- `pnpm patchy remove sales` reverses the declaration and its generated output, and removes its declaration skill when no declaration of that kind remains. It leaves the fixture for you and says so.
- An uneditable `uses` expression fails with its exact source line and, for add, the exact literal declaration line to insert. Either make `uses` an explicit object literal while preserving its meaning and retry, or add the declaration yourself and run `pnpm patchy refresh`. Do not bypass the refusal by editing generated metadata.
- `pnpm patchy refresh` fetches one release, updates the pin and installs if needed, re-execs that CLI, executes config, generates, and activates the managed set transactionally. Failure retains the previous set. It refreshes every present skill and adds config-implied skills; presence is sticky. If a present skill is no longer offered, refresh fails rather than leaving stale instructions.
- Every command accepts `--json`: success is one stdout document; failure is `{ ok: false, error, kind, code? }` on stderr. Exit 1 is locally fixable, 2 an instance refusal, 3 no usable answer, 130 interrupted. Branch on a returned `code`, not prose. Missing key: `Run: patchy login`; an agent relays the login URL and code to the person, never signs in for them.
- Repo publish writes the returned id into `patchy.json` on a create. Preserve `.patchy/publish/` after interruption or failed id writes and rerun as the same owning user: recovery precedes release checks and rebuilding. `pnpm patchy share company|public` and `pnpm patchy delete` use that id. After a deleted-patch 404, remove `patch` from `patchy.json` only when intentionally starting a new patch.
- `pnpm patchy dev status`, `stop`, `logs` and `reset` inspect or control this repo and instance only. `reset` stops and wipes disposable local state without changing published resources; start again afterwards to fetch the published inventory. `--foreground` stays attached and streams logs; interrupting a session it started stops it. On `release_mismatch`, run `pnpm patchy refresh`; an existing session is not killed by an upgrade.

Managed files are exactly the `patchy` pin, `patchy/_generated/`, `.agents/skills/patchy-*/`, missing fixture stubs, the lockfile through installation and one `uses` edit for add/remove. Never manually edit `_generated/`, the managed skills or revision stamps. The CLI writes `manifest.json` from local config execution; the instance returns finished files and resolved declaration stamps, never executable config. `AGENTS.md`, `CLAUDE.md`, application source and existing fixtures remain yours after initialization.

Commit config, `patchy.json` (instance and optional patch id), generated output, skills, fixtures and lockfile. Keep personal credentials outside the repo. `.patchy/`, `node_modules/` and `dist/` are ignored. Deleting `.patchy/` destroys local rows and files; it is not an innocuous cache cleanup.

## Data boundary

Development uses local PGlite data and agent-authored fixtures. Only metadata and published inventory come from the instance, never production rows or files. Fill each declaration's fixture stub with invented local `INSERT` statements matching its header; views are synthetic local tables. Missing fixtures are not permission to query production. Owned-table example rows are inserted through the local generated client, not a cloud data dump.

New starts bind the local viewer from the publishing key's `/api/me` identity and refresh declaration metadata. Dev calls are not logged and load no connection keyring or runtime log store. Before the first publish, schema changes recreate local data. Afterwards, the published inventory is the baseline: additive changes preserve rows, and changes publish would refuse are refused locally with the same object/change/fix. A local-only schema incompatible with an otherwise valid config can be recreated.

Every readable row is available to whoever can open the patch. Owned-table and file writes act as the viewer; every write is logged for company admins. UI filters and `me()` are not row-level authorization or a place to hide secrets. Shared tables and Postgres are read-only, checked against live source access. A public patch returns null from `me()` and `not_available_on_public` for data operations, even for a signed-in member.

## Tier 1 constraints

A tier 1 patch acts as the viewer only through Patchy and never holds their login. Use the generated client through the shell's broker; there is no direct runtime HTTP access from a frame.

- No outbound fetches, external links, external scripts, styles or assets. Bundle code and styles into one HTML file; use embedded data or blob URLs for images, fonts and media. Outside systems are reached only through company integrations.
- No client storage: `localStorage`, IndexedDB and cookies are unavailable. Save durable state in declared tables and file stores; keep transient UI state in memory.
- No popups, `target=_blank`, top navigation, in-frame downloads or workers. Shell-mediated routing and downloads belong to the broker; do not invent unsupported client methods or navigate around the sandbox. Address segments beginning with `~` belong to Patchy.
- Native form submission is blocked, including its `submit` event. Use `type="button"` click handlers and an Enter key handler for inputs, calling the generated client; keep validation with `reportValidity()`.
- No camera, microphone or geolocation. Clipboard writes must be user-triggered and have a visible failure state.
- Access loss is not a broken patch. The shell owns notices for `access_denied`, `session_expired` and `principal_changed`; a changed session needs a fresh page under the new identity. Never swallow these into an empty success result.
- `unknown_outcome` means a request left without a reply. Never automatically replay a mutation. Reconcile by reading before offering a deliberate retry.

Use bounded pages, not fetch-everything browser filtering. Respect `too_large`, `rate_limited`, `too_many_requests` and `busy` rather than fanning out more calls. The runtime defaults are 300 calls per viewer per patch per minute and at most 32 outstanding requests or 64 MiB held by a frame. The tier 1 HTML bundle cap is 10 MiB; table, file and Postgres skills describe their own bounds.
