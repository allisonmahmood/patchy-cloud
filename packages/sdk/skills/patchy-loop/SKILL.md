---
name: patchy-loop
description: Build in a Patchy repo, discover company tools and data sources, refresh generated files, choose declarations, or diagnose release and local-development boundaries. Read before changing patch code.
---

# Build in a patch repo

## Start with the repo

Talk through edge cases and product behaviour with the person before building.

1. Read `AGENTS.md` for the purpose and layout, then `patchy/_generated/README.md` and `patchy/_generated/index.json` for available skills, declarations, context paths and revision stamps. Initialization already installed dependencies: use the pinned `pnpm patchy` command, not a global copy, and do not reinstall as a setup ritual. `pnpm patchy --help` lists commands in this release.
2. Read `patchy.config.ts` for the tier, owned tables and file stores, and connections and shared tables in `uses`. Choose the page workflow from the tier and existing source:
   - Tier 0 is static HTML. Edit `index.html`; the page cannot run scripts or call resources. It does not need Preact or `src/App.tsx`.
   - Tiers 1 and 2 start with Preact in `src/App.tsx`, mounted by `src/main.tsx`. Read `../patchy-preact/SKILL.md` before changing components or hooks.
   - Tier 2 puts handlers in `server/`. Read `../patchy-server/SKILL.md`; the page calls `patchy.server.<module>.<handler>`, not tables, named files or connections directly.
   - A vanilla tier 1 repo keeps its existing entrypoint and framework-free generated client. Refresh does not convert it to Preact.
     Read `../patchy-tables/SKILL.md` for rows, `../patchy-files/SKILL.md` for bytes, and each declaration's skill and generated context before using it. In a scripted page, import the generated client by relative path; from `src/App.tsx` or `src/main.ts`, use `import { patchy } from "../patchy/_generated/client.js"`.
3. Edit source, config and invented fixtures. Run `pnpm patchy refresh` after changing definitions, declarations, tier or server module filenames. The generated index must name every declaration and its context before you use it. Run `pnpm typecheck` and, when `package.json` supplies a lint script, `pnpm lint`; the Preact scaffold supplies both. Repair source or config, never generated output.
4. Run `pnpm patchy dev --json` and open `url`. Tiers 1 and 2 also return `colleagueUrl`, a separate origin for a fixed non-admin viewer sharing the same local data. Exercise both viewers through the real shell, using invented fixtures. The command is healthy on return and idempotent. `src/` rebuilds reload the shell; tier 2 `server/` saves atomically rebind without reload and discover new modules, logging a reminder to refresh types. Existing calls and nested calls finish on their old binding. Subscriptions rerun on the new one, discard crossing results and end permanently for removed handlers or incompatible arguments. Failed builds retain the last good binding. Config and fixture edits need stop/start. A standalone Vite preview cannot exercise capabilities.
5. When asked to publish, run `pnpm patchy publish` from the repo root. It recovers any saved attempt first; otherwise checks the release, executes config, verifies declarations and server module names, typechecks and builds the HTML bundle. Tier 2 also builds a closed server module; dev and test instances inspect and serve it. Fix `stale_generated` with `pnpm patchy refresh`, build errors in source, and `not_additive` using the reported object/change/fix. Tier 2 is company-only: publish to a public patch with `--share company`. Report the address, scope, tier, version, artifacts, handlers, provisioned and unused resources.

<!-- sdk-capabilities -->

## Moving tiers

Tier 1 is the default. Use tier 2 for enforced rules, atomic multi-row writes or
server-side work. Tier 1 already supports live sync and sequential operations;
neither requires tier 2.

- To move from tier 1 to 2, set `tier: 2` in `patchy.config.ts`, create handler
  modules in `server/`, then run `pnpm patchy refresh`. It adds the exact
  `workerd` pin, config-bound `patchy/_generated/server.ts` and `patchy-server`.
  Run `pnpm typecheck`; the server-only client identifies every direct call to
  move into a handler. Use queries for reads, mutations for atomic owned-table
  writes and actions for files or integrations. Publish with `--share company`
  if the patch is currently public.
- To move from tier 2 to 1, set `tier: 1`, remove `server/`, then run
  `pnpm patchy refresh`. It removes the `workerd` pin, generated `server.ts` and
  `patchy-server` skill. This tier-keyed removal is the exception to sticky
  skills. Run `pnpm typecheck` and rewrite every `patchy.server.*` call it names.
  Tier 1 cannot retain handler-enforced rules or cross-call transactions.
  Publishing or rolling back to a tier 1 version makes public sharing possible
  again; a local config edit alone does not change the served tier.

Refresh never migrates application source or rewrites `AGENTS.md`. Both moves
keep the same patch id and its data. The typecheck must pass before publishing.

## Source and import boundaries

For scripted pages, `src/` owns the page; tier 0 keeps static HTML in `index.html`.
Put reusable company code in `helpers/`; page-only helpers
may stay under `src/`. `server/` contains tier 2 handler modules.
Importing a helper at runtime also imports its dependency
graph: a server import inside a helper leaks into the page. Keep shared helpers
browser-safe and use `import type` for server contracts.

Dev and publish check page and server graphs, not `package.json`. An unsupported runtime
import is local `import_refused`, exit 1; the message names the package, importer
and allowed entrypoints. Use the catalogue above, or write or copy the code into
the patch as your company's own code. `patchy/config` is for config execution,
not page runtime imports. Framework-free tier 1 pages still use the generated client.

## CSV import and export

`patchy/csv` is based on PapaParse. It has its own synchronous text API, not
PapaParse's options, and works in both page and server import graphs:

```ts
import { parse, records, stringify, CsvError } from "patchy/csv";

parse(text); // string[][]
records(text); // { headers: string[], records: Record<string, string>[],
//   errors: { line: number, expected: number, actual: number }[] }
stringify(rows, { formulaProtection: true }); // string
```

`parse` and `records` accept a leading BOM, CRLF or LF and quoted multiline
fields. Cells stay strings, with no trimming or type conversion. Only empty
physical lines are skipped; whitespace-only, quoted-empty and delimiter-only
rows remain. A final line terminator adds no extra row. `parse` preserves each
row's field count, including empty cells and uneven widths.

`records` uses the first retained row as headers. Duplicate headers throw.
A wrong-width row is omitted from `records` and reported in `errors` with
its 1-based starting physical line, expected field count and actual field
count. Rows are never padded or truncated. Empty input returns empty headers,
records and errors.

Both parsers enforce 10,000,000 input characters and 1,000,000 cells while
parsing. Fatal failures throw `CsvError` with `code` and a 1-based physical
`line` when applicable. An unterminated quote fails the entire parse and
names the opening quote's physical line; no partial result is returned.
Limit errors carry `code: "limit_exceeded"`, `limitId` of `csv.characters`
or `csv.cells`, and `value` containing that limit's fixed bound.

`stringify(rows, options?)` accepts readonly rows of strings and numbers,
writes CRLF and quotes fields as needed. Formula protection defaults to
`true`: a text cell starting with `=`, `+`, `-`, `@`, a tab or a CR gets a
leading `'`. Numbers are untouched. This is not lossless; parsing protected
output preserves the added apostrophe. Use `{ formulaProtection: false }`
only when the export needs the original text rather than this protection.

## Generated downloads and printing

The generated client's `patchy.download(name, data): Promise<null>` accepts
`Blob`, `Uint8Array` or `ArrayBuffer` on tier 1 and 2 pages, including public
tier 1 patches. It is Core, separate from stored-file downloads in
`../patchy-files/SKILL.md`; it needs no file store.

```ts
const csv = stringify([
  ["Name", "Balance"],
  ["Avery", -12]
]);
await patchy.download("balances.csv", new Blob([csv], { type: "text/csv" }));
```

The shell enforces 20 MiB of encoded bytes, not characters, and shows a
download card with the filename and size. The viewer must click Download
there; a claimed click inside the frame grants no permission. `Not now`
discards the offer and rejects with `invalid_request` and
`details.reason: "download_discarded"`. The promise waits for the viewer without
a runtime-call timeout. Resolution means browser handoff, not that the person
saved the file to disk. Closing or reloading loses pending files; closing the
client rejects pending calls with `unknown_outcome`. Show export success only
after the handoff.

`window.print()` works in the frame, including the browser's print-to-PDF.
The catalogue states which generation and formatting helpers the SDK does
not yet offer; those gaps are not prohibitions on company code.

## Description notices

`patchy.json.description` is the patch's published description; front-load what
the tool does. The purpose in `AGENTS.md` stays independent, and table/store
descriptions live in `patchy.config.ts`.

At refresh, new dev starts and fresh publish, a newer cloud description stamp
pulls that text into `patchy.json`, recording `descriptionSyncedAt`. Relay the
"The description was changed in the portal to '…'; check it" notice and check
the text; it quotes replaced local text when different. A local edit leaves
the stamp unchanged. Publish sends the pulled text and records the returned stamp.
Repo publish requires a nonempty description of at most 500 normalized Unicode
code points. Use `pnpm patchy describe "<text>"` to update both cloud and repo
without publishing. `describe --clear` explicitly empties it; refill before publish.
`publish --description` is file-only, not a repo override.

Refresh, new dev starts and publish also compare executed definitions with the
last generated manifest. If a table or store changed but its description did
not, check the reminder against what one row or object means, its keys and units.
Update its config description if needed. These notices do not stop commands;
under `--json` they are entries in `warnings`, including when a later step
fails. Relay them even on failure; a publish retry retains the saved notices.

## Discover before declaring

1. Run `pnpm patchy list --json` and choose candidate patches by description.
   `list patches` is identical and also includes connections. No match means
   "none you can use"; check `list --state retired --json` before concluding a
   tool does not exist.
2. Run `pnpm patchy list <patch> --json` for its cumulative tables, stores and
   reads across retained versions. Names and canonical ids work; a pasted URL
   resolves by its final path segment. Null `inventory` means unavailable,
   not an empty set.
3. Run `pnpm patchy list <patch> <table-or-store> --json` to inspect its
   definition, sharing and schema revision. These commands inspect metadata,
   never rows or file contents.
4. Choose a table or store marked `declarable: true`, then run
   `pnpm patchy add shared-table <patchId>/<table> --as <alias>` or
   `pnpm patchy add shared-store <patchId>/<store> --as <alias>` with the
   returned canonical id. Branch on `declarable` and `reason`, not the human
   `hint`. Ask the named owner about `not_shared`; `source_off` needs
   restoration before use.

`list` runs anywhere under the saved login and never reads `patchy.json`.
It uses normal instance selection, not the repo's binding; pass `--api-url`
when needed. `--state live|retired|all` defaults to `live` at all three patch
levels. Keep `--state retired` on a retired candidate's drill-down. Deleted
patches need their id and `--state all` at both detail levels, never a name.
An API `wrong_state` refusal is exit 2 with the actual state and flag guidance.
Its JSON failure includes the patch's actual `state` beside `code`.
`--mine` applies only to `list` and `list patches`; `--all` applies only to
`list connections`, not connection detail. Patch flags do not apply to
connections. Wrong-level flags are local errors, exit 1.
Every level accepts `--json`: the top merges `{ patches, connections }`;
all other levels print the wire body with no added `ok` wrapper.

For Postgres, run `pnpm patchy list connections`, then
`pnpm patchy list connections <handle>` for its schema snapshot and `takenAt`.
`list connections --all` adds offered integrations. A null snapshot is
unavailable, not an empty database. Only connected entries carry an `add` hint;
disconnected entries point to `/company/connections`. Discovery grants no access.

## Commands and ownership

- `pnpm patchy add postgres/<handle> --as sales` or `pnpm patchy add shared-table <patchId>/<table> --as contacts` edits `uses` and generates its client, context, fixture stub and skill. Choose the target through discovery above. `add postgres` chooses a sole connected Postgres connection; with several it lists choices from `list connections` and stops. Connection setup belongs to an admin at `/company/connections`; keep credentials out of the repo and transcript.
- `pnpm patchy remove sales` reverses the declaration and its generated output, and removes its declaration skill when no declaration of that kind remains. It leaves the fixture for you and says so.
- An uneditable `uses` expression fails with its exact source line and, for add, the exact literal declaration line to insert. Either make `uses` an explicit object literal while preserving its meaning and retry, or add the declaration yourself and run `pnpm patchy refresh`. Do not bypass the refusal by editing generated metadata.
- `pnpm patchy refresh` fetches one release, updates the managed pins and installs if needed, re-execs that CLI, executes config, generates, and activates the managed set transactionally. Failure retains the previous set. It refreshes every present skill and adds config-implied skills; skills stay sticky except that `patchy-server` is removed below tier 2. If another present skill is no longer offered, refresh fails rather than leaving stale instructions. It announces newly recorded SDK capabilities with their entrypoints, where they run and limits; `--json` returns them in `addedCapabilities`. Older repos record the full catalogue once, and an unchanged refresh returns an empty list.
- Every command accepts `--json`: success is one stdout document; failure is `{ ok: false, error, kind, code?, state?, owner?, dependants?, sources?, purgeAt?, warnings? }` on stderr. Inspect and relay `warnings` even on failure. Exit 1 is locally fixable, 2 an instance refusal, 3 no usable answer, 130 interrupted. Branch on a returned `code`, not prose. Missing key: `Run: patchy login`; relay the login URL and code to the person.
- Repo publish writes its returned id and description sync stamp into `patchy.json`. Preserve `.patchy/publish/` after interruption or failed writes and rerun as the same owning user; recovery precedes release checks and rebuilding. Untargeted `share`, `retire`, `delete --yes`, `restore`, `rollback <n>` and `describe` use that id. Keep it on `not_owner`, `patch_retired` or `patch_deleted`; arrange reassignment or restoration. Only a gone patch's 404 calls for removing `patch` when intentionally starting a new patch.
- Retire and delete from live refuse with `has_dependants`; restore with unavailable sources refuses with `sources_off`. Relay the list and ask the person you are working for before forcing. `--force` accepts breakage, including an unshare at publish; `--yes` only confirms deletion. Delete keeps everything for 30 days until `purgeAt`, retire indefinitely. Rollback changes only the live served version, not data, sharing, description or name.
- `pnpm patchy dev status`, `stop`, `logs` and `reset` inspect or control this repo and instance only. `reset` stops and wipes disposable local state without changing published resources; start again afterwards to fetch the published inventory. `--foreground` stays attached and streams logs; interrupting a session it started stops it. On `release_mismatch`, run `pnpm patchy refresh`; an existing session is not killed by an upgrade.
- Dev and publish refuse unsupported loaded Vite or single-file plugin versions with local `toolchain_unsupported`, exit 1. Run the upgrade command in the error and retry. `refresh` only warns; those dependencies belong to you and are never rewritten by refresh.

Managed generation files are exactly the `patchy` pin and tier 2's `workerd` pin, `patchy/_generated/`, `.agents/skills/patchy-*/`, missing fixture stubs, the lockfile through installation and one `uses` edit for add/remove. Refresh owns pin changes and the generated server module list, and removes stale generated context files. Adding, deleting or renaming a server module requires refresh; publish refuses a stale list with `stale_generated`. Description sync separately updates `patchy.json`; pulled text remains there if a later step fails, with its notice in the failure. Never manually edit `_generated/`, the managed skills or revision stamps. The CLI writes `manifest.json` from local config execution; the instance returns finished files and resolved declaration stamps, never executable config. `AGENTS.md`, `CLAUDE.md`, application source and existing fixtures remain yours after initialization.

Commit config, `patchy.json` with its description and sync stamp, generated output, skills, fixtures and lockfile. Keep personal credentials outside the repo. `.patchy/`, `node_modules/` and `dist/` are ignored. Deleting `.patchy/` destroys local rows and files; it is not an innocuous cache cleanup.

## Data boundary

Development uses local PGlite data and agent-authored fixtures. Only metadata and published inventory come from the instance, never production rows or files. Fill each declaration's fixture stub with invented local `INSERT` statements matching its header; views are synthetic local tables. Missing fixtures are not permission to query production. Owned-table example rows are inserted through the local generated client, not a cloud data dump.

New starts bind the primary viewer from the publishing key's `/api/me` identity and refresh declaration metadata. Tiers 1 and 2 also mount a fixed non-admin colleague. `dev.log` records viewer, handler, outcome, milliseconds, `ctx.log` output and local-only failure message/stack. Starting with `--json` records full wide events and invocation JSON; `dev logs --json` returns `{ ok, log, text }`. No runtime database log rows, PostHog delivery or connection keyring are used. Before the first publish, schema changes recreate local data. Afterwards, the published inventory is the baseline: additive changes preserve rows, and changes publish would refuse are refused locally with the same object/change/fix. A local-only schema incompatible with an otherwise valid config can be recreated.

`patchy dev` runs the same handler engine and callback path as production.
It does not reproduce production's scheduling, limits or containment. A handler
that spins forever times out, and a health check restarts the dev engine, which
can interrupt other calls in flight. Contract limits still apply; production
operating capacity does not. PGlite is not evidence for hosted `busy` or
`write_conflict` behavior. Tier 2 reads invented shared and Postgres fixtures
through `ctx.shared` and `ctx.connections`.

On tier 1, every readable row is available to every admitted company viewer, and owned-table and file writes act as the viewer. UI filters and `me()` are not row-level authorization or a place to hide secrets. Tier 2 puts enforced rules in handlers; owned resources act as the patch, while company data is authorized as the initiating viewer. Writes are logged for company admins. Shared tables and Postgres are read-only, checked against live source access. A public tier 1 patch returns null from `me()`. Signed-in company members can read its declared member directory; anonymous viewers and outsiders cannot. Tables, files and integrations still return `not_available_on_public` for everyone. Tier 2 cannot be public.

## Presence and live screens

Patchy owns presence through each document's stream, including reconnect and
access-loss notices. Keep presence out of patch tables and heartbeat code.
Render from the subscription's latest result rather than copying mutation
replies into a second query-state cache. Tier 1 table subscriptions work in dev
and hosted company pages. Tier 2 query subscriptions work through the same
document stream in local dev and published dev/test instances. Read
`patchy-server` for handler and subscription limits.

## Tier 1 constraints

A tier 1 patch acts as the viewer only through Patchy and never holds their login. Use the generated client through the shell's broker; there is no direct runtime HTTP access from a frame.

- No outbound fetches, external links, external scripts, styles or assets. Bundle code and styles into one HTML file; use embedded data or blob URLs for images, fonts and media. Outside systems are reached only through company integrations.
- No client storage: `localStorage`, IndexedDB and cookies are unavailable. Save durable state in declared tables and file stores; keep transient UI state in memory.
- No popups, `target=_blank`, top navigation, in-frame downloads or workers. Shell-mediated routing and downloads belong to the broker; do not invent unsupported client methods or navigate around the sandbox. Address segments beginning with `~` belong to Patchy.
- Native form submission is blocked, including its `submit` event. Use `type="button"` click handlers and an Enter key handler for inputs, calling the generated client; keep validation with `reportValidity()`.
- No camera, microphone or geolocation. Clipboard writes must be user-triggered and have a visible failure state.
- Access loss is not a broken patch. The shell owns notices for `access_denied`, `session_expired` and `principal_changed`; a changed session needs a fresh page under the new identity. Never swallow these into an empty success result.
- `unknown_outcome` means a request left without a reply. Never automatically replay a mutation. Reconcile by reading before offering a deliberate retry.

Use bounded pages, not fetch-everything browser filtering. Respect `too_large`, `rate_limited`, `limit_exceeded`, `too_many_requests` and `busy` rather than fanning out more calls. The frame allows 32 outstanding requests or 64 MiB held, not 32 simultaneous company operations. By default each company has 4 database connections per host replica, with at most 32 waiters for at most 1 second inside the call's deadline; contention returns `busy`. Company admission defaults to 100 calls/second with a burst of 200 and returns `limit_exceeded`. Respect `retryAfter`; company operating bounds may have overrides. The viewer limit is 300 calls per patch per minute. The tier 1 HTML bundle cap is 10 MiB; table, file and Postgres skills describe their own bounds. Tier 2 action and re-run concurrency bounds are in `patchy-server`.
