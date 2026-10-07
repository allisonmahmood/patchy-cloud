# ADR-0004 — CLI contract for agents

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Publishing (`packages/patchy`). System-wide because every agent driving the CLI and the cloud worktree's dev runner depend on this contract.
- **Source**: Effect v4 port spec (#68) §5; [CLI contract on Effect cli](https://github.com/allisonmahmood/patchy-cloud/issues/60#issuecomment-5456839739); [Local dev environment](https://github.com/allisonmahmood/patchy-cloud/issues/15); [auth spec §10](https://github.com/allisonmahmood/patchy-cloud/issues/135); [SDK map decisions](https://github.com/allisonmahmood/patchy-cloud/issues/164) and [SDK spec §§7–8, 13–14](https://github.com/allisonmahmood/patchy-cloud/issues/193); [agent discovery #252](https://github.com/allisonmahmood/patchy-cloud/issues/252), [portal spec §§7–8](https://github.com/allisonmahmood/patchy-cloud/issues/247) and [the company look #547](https://github.com/allisonmahmood/patchy-cloud/issues/547).

## Context

An agent is the CLI's primary driver, a developer a real secondary one. Both
need to distinguish a mistake in the call from an instance refusal and an
unusable network answer without parsing prose. Repo generation, detached dev and
recoverable publish add commands, not alternative output or identity conventions.

## Decision

One npm package, `patchy`, owns the binary and its explicit config, client, server,
dev and Preact entry points at one exact release. It remains private and is distributed by
the instance until launch, through the installer its `/llms.txt` names. Inside a patch repo, `pnpm patchy` runs the pinned
copy. [ADR-0011](./ADR-0011-one-package-one-release.md) owns release distribution
and the stable runtime wire; this ADR owns the CLI's observable contract.

### Exit codes and output

| code | kind          | meaning                                | examples                                                                                                                                |
| ---- | ------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | ok            | the command's act succeeded            | login handoff or pending; healthy dev; local logout despite failed courtesy revocation                                                  |
| 1    | `local`       | correct the call, files or local state | bad args, missing file/key, invalid HTML, stale generation, local release mismatch, unhealthy dev                                       |
| 2    | `rejected`    | the instance returned a refusal        | rejected key, unavailable patch, quota, `name_taken`, `not_additive`, decoded `busy`/`source_unavailable`, denied/expired/unknown login |
| 3    | `unreachable` | no usable answer from the instance     | DNS/connect/timeout, an unmodelled 5xx, a body the wire schemas cannot read                                                             |
| 130  | interrupted   | SIGINT or SIGTERM interrupts the fiber |                                                                                                                                         |

A decoded wire refusal is `rejected`, including the API's declared 503
`busy` and `source_unavailable` responses. Otherwise HTTP 4xx maps to `rejected`;
transport failures, unmodelled 5xx and unreadable bodies map to `unreachable`.
An invalid local URL or a request that cannot be encoded is `local`.
`CliError` and `exitCode(kind)` supply one ladder, and `Output.contract` renders
command failures. A defect is `Unexpected error: <message>`, exit 1, with a
stack only at `--log-level debug`. Text diagnostics may include repair steps or
lists of validation failures; their line count is not the branching contract.

`--json` is global, accepted before or after the subcommand:

- **Success:** exactly one stdout JSON document, with the command's shape below.
  Warnings are fields in that document, never JSON-mode stderr; install, build
  and generation progress do not leak into stdout. `status` always uses JSON.
- **Failure:** one stderr document `{ ok: false, error, kind, code?, state?, owner?, dependants?, sources?, purgeAt?, admins?, warnings? }`, ordinarily
  empty stdout, and the exit code for `kind`. `code` preserves exposed wire
  refusals and identifies [local repo checks](#local-repo-refusal-codes), plus
  local dev codes such as `not_additive` and `not_running`; not every error has one.
  Discovery's `wrong_state` refusal includes the actual patch `state`.
  Lifecycle refusals retain `owner` for `not_owner`, `dependants` for
  `has_dependants`, `sources` for `sources_off` and `purgeAt` for `patch_deleted`.
  The look's `admin_required` retains `admins`.
  Notices discovered before a later failure remain in `warnings`; text mode
  prints them before the error.
  Terminal device-login refusals currently use `kind` and `error` without a code.
- **Parse errors:** Effect may print usage to stdout before the failure document.
  Check the exit code before parsing stdout as success. Built-ins such as help
  and the bare `--version` retain their own output, not success envelopes.

`whoami`, `publish`, `share`, `retire`, `delete`, `restore`, `rollback`, `describe`, `look publish` and `look restore` expose their API success shapes;
[API reference](../API.md) owns those fields. `publicUrl` on publish/share is an
address, not a promise of anonymous access: `scope` decides who can open it.

### Local repo refusal codes

Branch on the exit code and `kind` first, then on `code` when present. These
local repo checks use exit 1 and `kind: "local"`; the same code received from the
instance is `rejected` (exit 2). Not every local failure has a structured code
(for example, compiler, bundle-completeness and local I/O errors).

| `code`                  | Meaning and remedy                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_mismatch`     | The effective target differs from the repo's stored instance, or the stored instance changed before result application. The diagnostic names both URLs. Remove or correct the effective override to match the repo; restore an unintended late target edit before recovery. Never remove the patch id or rebind the instance to bypass this refusal. |
| `release_mismatch`      | The repo pin, executing CLI or installed runtime differs from the instance release. Inside a repo the message names `pnpm patchy refresh`. File mode involves only the global CLI, so its message names the instance's install line with the instance URL; rerunning the installer upgrades it.                                                      |
| `toolchain_unsupported` | Dev or publish loaded Vite or `vite-plugin-singlefile` outside the release's accepted range. The diagnostic names the loaded version, accepted range and tested version, with the exact `pnpm add --save-dev` command. Change the builder-owned dependencies and any shared config's dependency resolution; refresh never writes those keys.         |
| `import_refused`        | The page or server graph imports outside its SDK entry points. The message names the package, importer and allowed entries, then the company-code rule. Page imports of server implementations are refused; type-only imports are allowed. This is a build contract, not a security boundary or dependency-list check.                               |
| `stale_generated`       | Generated release metadata, declaration stamps or the server module list no longer match the repo. Run `pnpm patchy refresh`.                                                                                                                                                                                                                        |
| `invalid_manifest`      | Config, manifest or server descriptor extraction failed. Fix the named source, declaration or handler before publishing.                                                                                                                                                                                                                             |
| `too_large`             | A bundle exceeds its local cap. HTML allows 512 KiB at tier 0 and 10 MiB at tiers 1 and 2. Reduce the resources named in the diagnostic.                                                                                                                                                                                                             |
| `tier_mismatch`         | The code does not fit its declared or supported tier. `server/` requires tier 2; browser code requires at least tier 1; tiers above 2 are not served.                                                                                                                                                                                                |

Description preflight in `init --purpose`, `describe` and file publishing with
`--description` can also emit `invalid_description` locally (exit 1), before any
description request is sent. `look publish` likewise emits `invalid_look` locally
before sending a look the instance would refuse. Repair the text using the reported constraint.
An instance's HTTP 422 `invalid_description` is still `rejected` (exit 2).

The tier 2 contract's descriptor extraction refuses a non-handler export from a
one-level server module with `invalid_manifest`, local exit 1. A handler must
declare a query, mutation or action with valid argument and result descriptors.
Tier 2 publication is admitted on dev and test instances. The server inspects
the stored server bytes in a throwaway process. A descriptor disagreement,
top-level throw, unresolved module or unfinished initializer is HTTP 422
`invalid_manifest`, `kind: "rejected"`, exit 2. A tier 2 repo with no handlers
publishes with a warning. Production admits tier 2 only with
`EXECUTION_PROVIDER=ecs`. Production infrastructure is written
([#415](https://github.com/allisonmahmood/patchy-cloud/issues/415)) and awaits its
first deploy ([#416](https://github.com/allisonmahmood/patchy-cloud/issues/416)).

The browser runtime has its own refusal contract in [API](../API.md), not CLI
exit codes. It includes `handler_failed`, `handler_timeout`, `write_conflict`,
`patch_paused`, `server_required`, `limit_exceeded` and `invalid_row`.
`busy` carries the applicable limit and safe retry delay; it is not a serialization
conflict. `unknown_outcome` on a tier 2 mutation offers explicit same-key
`retry()`; actions are never replayed. A declared `HandlerError` is a
`source: "handler"` result, distinct from Patchy's `source: "patchy"` refusals.

### Instance, credentials and local state

For `list`, `init` and file-oriented commands, the instance is resolved once per command:

`--api-url` > nearest upward `.local/dev/env` > `PATCHY_API_URL` > saved config >
`http://localhost:3000`.

For repo commands (`refresh`, `add`, `remove`, `dev` and its
subcommands, no-file `publish`, untargeted lifecycle/description/sharing commands, and private
generation), the instance stored in `patchy.json` is authoritative. Select the
effective override from `--api-url` > `.local/dev/env` > `PATCHY_API_URL`.
If present, it must match the stored URL after normalization; a mismatch is
`instance_mismatch` before any HTTP request, naming both targets. Ignored
lower-precedence settings cannot cause a mismatch. With no override, the repo
instance wins over saved config and the default. A matching override retains
its URL source and credential behavior. `list`, `init` and file mode do not read
this repo binding. `list` runs anywhere under the saved login and never reads
`patchy.json`. Correct the effective override rather than deleting the patch id
or changing the stored instance to bypass a refusal.

One service exposes the resolved source: `flag`, `dev-env`, `env`, `project`,
`config` or `default`. `status --json` reports its URL and source; text publish
names both. A cloud worktree's dev env deliberately outranks environment and
saved config, but cannot silently move a repo bound elsewhere.

Protected commands resolve the key as `PATCHY_API_TOKEN` > stored credential for
that instance > the seed, available only when the URL source is `dev-env`.
An explicit `--api-url` does not inherit the seed, even for the same URL. A saved
login outranks the seed; logout exposes the seed again unless an environment key
wins. A new protected operation without a key exits 1 with `Run: patchy login`;
no command starts a login or replaces a rejected key on the caller's behalf.
Healthy existing dev sessions and dev management do not need a current key.

State is per instance under `PATCHY_STATE_DIR` (default `~/.patchy`): saved URL,
credentials, pending device login, file patch cache and file-mode publish attempts.
Empty environment settings act as unset. Instance keys trim whitespace and
trailing slashes; schemes, hosts and ports otherwise remain distinct. Saved keys
carry `source: "login"` or `"auth-set"`; login also records the machine id/name.
Credentials and pending device logins are owner-only. Neither publishing keys nor
private device codes appear in command output. The previous single-instance
state formats are refused, not silently discarded or migrated; the diagnostic
names the file requiring repair. A legacy `drafts.json` cache must be explicitly
renamed to `patches.json` or removed.

| command                                             | behaviour                                                                                                                                                                                                                                | `--json` success                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `patchy auth set [--token-stdin] [--api-url <url>]` | Save an existing key for the instance; save an explicit URL too. Default is a terminal-only non-echoing prompt. `--token-stdin` explicitly accepts one nonempty redirected token and refuses a terminal. Never accepts a token argument. | `{ ok, instanceUrl }`                                                                                                    |
| `patchy whoami`                                     | Verify the selected key and print its user, company, role and machine.                                                                                                                                                                   | `Identity`: `{ user: { id, email, name }, company: { id, handle, name }, role, machine: { id, name } }`, no `ok` wrapper |
| `patchy status`                                     | Local availability report, no network; an absent key is not a failure. Unreadable credentials report unavailable without modifying them.                                                                                                 | `{ instanceUrl, instanceSource, hasToken, tokenSource, stateDir, hasDefaultStyle, cliVersion }`                          |
| `patchy setup [--remove]`                           | Link the package's bundled global skill directory as `~/.agents/skills/patchy` and `~/.claude/skills/patchy`; `--remove` deletes only links setup owns.                                                                                  | `{ ok, linked, skill }`; with `--remove`, `{ ok, removed, warnings }`                                                    |
| `patchy validate <file>`                            | Check the static-HTML policy without publishing or authenticating.                                                                                                                                                                       | `{ ok, warnings }`                                                                                                       |

Setup owns a link whose target is a `patchy` package's `skills/patchy`
directory, including a dangling one whose npm prefix is gone; it uses symlinks
on POSIX and junctions on Windows. Correct links are left untouched and owned
links to another package are replaced. Both paths are checked before either
changes: a directory, a file or a foreign link is exit 1 with `skill_conflict`
naming the path. `skill` is the bundled `SKILL.md`. Remove leaves anything it
does not own and reports it in `warnings`. The instance's `/install.mjs` runs
`setup --json` by absolute path after installing.

`status` walks the same key chain; `tokenSource` is `login`/`auth-set` only for a
selected saved key with that provenance, otherwise null. It is not proof a key
will be accepted: use `whoami`. The probe is tolerant of unreadable credentials;
commands that spend them fail closed on that local-state error instead.

### Device login and logout

`patchy login [--complete [code]] [--wait <seconds>]` sends the hostname as a
machine-name hint. Only a predecessor saved by login contributes its machine id
on re-login; environment, `auth set` and seeded keys do not.

Login waits automatically only when stdin is a terminal, `--json` is absent,
and none of `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CURSOR_AGENT`, `CODEX_SANDBOX`,
`CODEX_SANDBOX_NETWORK_DISABLED`, `GEMINI_CLI`, `OPENCODE`, `CLINE_ACTIVE`,
`AI_AGENT` or `CI` is present, even with an empty value. A PTY alone does not
identify a human. That human path prints the handoff and waits for an answer or
expiry. Every other new login prints the URL, code, reason and `next`, then exits 0. The agent relays the URL/code, leaves the browser to the person, and runs
`next` after the handoff. A nonblocking rerun with a pending login polls once
instead of minting another code; the original URL/code remains valid.

An explicit `--api-url` is saved and remains shell-quoted in `next`, because
saved config alone cannot override a worktree or environment URL. `next` does
not include `--json`; the caller adds it to request structured completion.

`--complete [code]` uses the pending login for this instance. Supply the optional
code as a separate argument (`--complete XXXX-XXXX`, not `--complete=XXXX-XXXX`);
a mismatched code is local and names the live one. Poll at the instance's
interval, adding five seconds on `slow_down`. Default wait is 60 seconds,
including in-flight responses and decoding; `--wait 0` waits for one poll's
answer rather than cancelling it immediately. A real pending answer followed
by exhaustion of the wait budget exits 0 and can resume with `next`. No answer
by the deadline is exit 3 with the pending record retained, never invented
`pending`. Denied, expired and unknown are exit 2; poll even after local expiry
so the instance reports and consumes the terminal answer.

| result          | `--json` success                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handoff         | `{ ok, status: "awaiting_confirmation", verificationUrl, verificationUrlBare, userCode, expiresAt, interval, next, agentNextSteps, notWaitingBecause }` |
| Still waiting   | `{ ok, status: "pending", userCode, expiresAt, next, agentNextSteps }`                                                                                  |
| Complete        | `{ ok, status: "logged_in", instanceUrl, company: { handle, name }, user: { email }, machine: { id, name }, credentialsPath, warnings }`                |
| `patchy logout` | `{ ok, instanceUrl, revoked, warnings }`                                                                                                                |

Completion saves the key and machine, then removes the pending login. Its
user/company receipt comes with the one-time mint response; no fallible follow-up
`/api/me` is needed. Persistence completes even if local I/O passes the wait
deadline. With `PATCHY_API_TOKEN` set, completion warns that the saved login is
still overridden; `whoami` verifies which credential the chain selects.

Logout forgets the stored key and pending login first, then courtesy-revokes
only the deleted key. An already-invalid 401 counts as revoked. Failure is exit
0 with a warning to revoke the key on **Your machines** or let its 30-idle-day
expiry pass. `revoked` is false when there was no stored key or revocation failed.
Logout warns about an environment key or worktree seed without revoking either.
It does not sign the browser out. These device and browser boundaries are
[ADR-0008](./ADR-0008-every-bearer-is-somebody.md).

### Discovery

Discovery reads metadata under the machine token without granting access.
The top level merges two routes; the other levels expose their wire body
unchanged, with no `ok` wrapper. [API reference](../API.md) owns the wire fields.

| command                                | behaviour                                                                                     | `--json` success                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `patchy list` or `patchy list patches` | Company patches, grouped Yours and Company, then Connections. Both forms include connections. | `{ patches, connections }`, merged from `GET /api/patches` and `GET /api/connections`              |
| `patchy list <patch>`                  | Patch row, description, cumulative Tables and Stores, and Reads across retained versions.     | Patch detail wire body, including `inventory: { tables, stores } \| null` and `reads`              |
| `patchy list <patch> <primitive>`      | One table or file store's definition, never contents.                                         | Primitive detail wire body `{ kind, name, description, shared, schemaRevision, columns, indexes }` |
| `patchy list connections [--all]`      | Company connections in both states; `--all` adds offered integrations.                        | Connections wire body `{ connections, offered? }`                                                  |
| `patchy list connections <handle>`     | Current immutable schema snapshot and its `takenAt`; unavailable when null.                   | Connection detail wire body `{ handle, description, status, snapshot }`                            |

`--json` applies everywhere. `--state live|retired|all`, default `live`, governs
the top level's patches and patch resolution at both detail levels. `all` includes
deleted patches not yet reclaimed, even after `purgeAt` while awaiting the sweep.
`--mine` is top level only, on `list` and `list patches`. `--all` is only for
`list connections`, not connection detail.
Patch flags are refused on connections. Wrong-level flags are local errors,
exit 1, rather than ignored filters. Agents filter JSON locally; there is no
search or paging.

A patch ref is a canonical id or exact current name in the caller's company.
A pasted URL resolves by its final path segment. Names resolve only non-deleted
patches; a deleted patch needs its id and `--state all` at both detail levels.
A resolved patch outside the requested state receives the API's `wrong_state`
409, exit 2. The failure document carries `state` beside `code`; text names the
state and its remedy: `retired; pass --state retired`, `deleted; pass --state all`,
or `live; pass --state live`. Unknown, gone and unopenable refs answer 404.
No match means none the credential can use, not proof a tool does not exist.
The skills teach agents to check `--state retired` before concluding absence.

Text patch rows lead with the id, then name, state, owner with `· deactivated`
when applicable, current version such as `v7`, and the description's first
line or `(no description)`. Deleted rows show `deleted · gone in N days`,
derived from the server's `purgeAt`, never a second local recovery deadline.
Patch detail prints `Tables: unavailable` for null inventory, not `none`.
Table detail prints column kinds, optionality, explicit defaults including
`null`, ref targets, indexes with `unique`, the shared flag and schema revision.
An absent default means no default.

Declarable shared tables get `patchy add shared-table <patchId>/<table>` hints;
shared stores get `patchy add shared-store <patchId>/<store>` hints. Resource
detail includes `shared`, `declarable`, `reason` and the add hint. Unshared
resources name the owner; off sources need restoration. Connected entries get
`patchy add postgres/<handle>`; disconnected ones point to `/company/connections`.
JSON agents branch on `declarable` and `reason`, never parse `hint`. Shared reads
name their resource in `table` or `store`, never label a store as a table.

### Patch-repo commands and managed files

| command                                                                                                                                                                 | behaviour                                                                                                                                                                                                                                                                 | `--json` success                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `patchy init [dir] [--tier 0\|1\|2] [--purpose <text>]`                                                                                                                 | Authenticate first, print instance/identity, ask purpose only at a human terminal, stage a new repo, install and generate before activating it. Default tier 1; tier 2 adds handlers and its managed engine pin. Target must be empty or absent under an existing parent. | `{ ok, dir, release, tier, generated, skills, installed }`                                                   |
| `patchy refresh`                                                                                                                                                        | Fetch one release, reconcile managed pins with the release and tier, install/re-exec as needed, generate and activate the managed set transactionally. Failure leaves the previous set intact.                                                                            | `{ ok, release: { from, to }, changed: { pin, generated, skills, fixtures }, addedCapabilities, warnings }`  |
| `patchy add postgres/<handle> [--as <alias>]`, `patchy add shared-table <patchId>/<table> [--as <alias>]` or `patchy add shared-store <patchId>/<store> [--as <alias>]` | Insert a literal declaration into `uses` by TypeScript AST without import changes, then generate client, context, missing fixture and skill.                                                                                                                              | `{ ok, alias, declaration, generated, skills, addedCapabilities, warnings }`                                 |
| `patchy add members`                                                                                                                                                    | Add `{ kind: "members" }` under the fixed `uses.members` alias, the typed client and `patchy-members` skill. No source id, revision stamp or fixture is generated.                                                                                                        | `{ ok, alias: "members", declaration: { kind: "members" }, generated, skills, addedCapabilities, warnings }` |
| `patchy remove <alias>`                                                                                                                                                 | Remove the declaration and generated output; remove its skill when unused. Keep any fixture. Refuse `remove members` while any configured member column exists.                                                                                                           | `{ ok, alias, removed, addedCapabilities, warnings }`                                                        |

`refresh` reports `changed.pin: true` when either managed pin changes, including
adding or removing `workerd` on a tier change. Its transaction restores both
pins and their installation on failure.

Agent, JSON and non-terminal `init` calls require `--purpose`; purpose is never
inferred. A company with no connections gets empty `uses` and core skills. The
tree includes `patchy.config.ts`, `patchy.json`, the package pin and lockfile,
app/build/typecheck sources, generated client and declaration metadata, project
skills and fixtures. Write-once `AGENTS.md` records purpose, layout, completed
installation, the generated index and `patchy dev`; `CLAUDE.md` imports it.
The starter config defines notes with `table(description, columns, options?)`;
file stores use `files(description, options?)`. Each description is required and nonblank,
and explains one row or object, its identifying keys, and relevant units.
Config execution refuses blank descriptions and table/store name collisions
as `invalid_manifest`, naming both conflicting definitions.
The tree typechecks without more setup. Nothing identifying the person is committed.

Tiers 1 and 2 start with an empty root in `index.html`, `src/main.tsx` and
`src/App.tsx`, using Preact with compat semantics through `patchy/preact`.
TypeScript and Vite share that JSX import source, and module preloading is off.
`pnpm lint` checks hooks, including `useQuery`, and rejects React and direct
Preact imports. Tier 2 adds a starter module in `server/`,
`patchy/_generated/server.ts` bound to config, and `patchy-server` alongside
`patchy-preact` and `patchy-loop`. Its page calls generated server queries and
mutations. Write-once `AGENTS.md` describes the page/handler split for either
tier. Tier 0 stays static; vanilla tier 1 repos keep the generated core client.

Tier 1 is the default. Enforced rules, atomic multi-row writes or server-side
work call for tier 2; live sync and sequential operations do not.
Changing tier is a config edit plus refresh, with no dedicated command or
source rewrite. Moving to tier 2 adds the `workerd` pin, generated `server.ts`
and `patchy-server`; typechecking names direct resource calls to move into
handlers. Moving to tier 1 removes those managed parts; typechecking names
`patchy.server.*` calls to replace. The builder removes `server/` before a tier
1 publish. Serving tier 1 by publish or rollback makes public sharing possible
again, not merely changing local config.

`addedCapabilities` contains `{ id, group, name, entrypoints, runs, limits }`
entries newly present since the last generated capability inventory. Text output
names each capability, where it runs and its limits. The inventory lives in
`patchy/_generated/index.json`; generation uses the same release catalogue to
render "What the SDK gives you" in `patchy-loop`. An older repo without an
inventory receives the catalogue once; an unchanged refresh returns `[]`.
Neither capability announcements nor refresh rewrite `src/`, `server/` or `helpers/`.

`patchy.json` is `{ instance, patch?, description, descriptionSyncedAt? }`.
`init --purpose` writes its normalized purpose as `description`, with at most
500 Unicode code points, one paragraph and no control characters. An overlong
purpose reports the count and bound; interactive init re-prompts. The purpose
in write-once `AGENTS.md` is independent and never synced.

Repo publish requires nonempty `description`, otherwise local `invalid_manifest`.
Its manifest carries the text and success records the returned
`descriptionUpdatedAt` as `descriptionSyncedAt`. `refresh`, a new `dev` start
and fresh `publish` read the cloud description and stamp from patch detail.
When the cloud stamp is later, they write its text and stamp to `patchy.json`
and print "The description was changed in the portal to '…'; check it",
quoting the replaced local text when different. Publish sends that pulled text.
Local edits leave the stamp unchanged; unchanged cloud text never overwrites them.

Those three commands compare executed table/store definitions with the last
generated manifest before replacing it. A changed definition with byte-identical
description prints "Table `orders` changed since its last generation; check that
its description still holds: '…'". New definitions produce no reminder.
Omitted boolean defaults and explicit `false` have the same definition.
Sync notices and primitive reminders are nonblocking and appear as `warnings`
entries in JSON success documents, or failure documents if a later step fails.
The company look rides the same path. When `refresh` or a new `dev` start
brings in a look revision other than the one `index.json` had, and the page's
source names `patchy/_generated/look.css` or `logo.svg`, a `warnings` entry
reads "Acme's look changed, rev 7 → 8 by Sam: darker green. Colours and fonts
follow; to restyle this tool's components, ask your agent to update it to the
current look." Repo `publish` never pulls a revision: for such a page behind the
company's current revision it ships the repo's own, exits 0 and adds a
`warnings` entry naming `patchy refresh`.

`patchy add postgres` chooses the sole connected Postgres connection; with
several it lists copy-ready choices from `list connections` and stops, and with
none it names `/company/connections`. Default aliases camel-case Postgres handle hyphens or use
the shared table or store name; `--as` overrides the default. An uneditable `uses`
expression fails with the exact source line and declaration line to add before
refresh. Shared-table and shared-store add read the named source's discovery
detail, check that the resource is declarable, and record its canonical patch id.
They do not enumerate connections or shared resources; use `list` for discovery.
Store declarations have `kind: "sharedStore"`, `patchId`, `store`, the canonical
`id` as `<patchId>/<store>`, and the source inventory's `revision` stamp.
Stale stamps warn as for shared tables. Removing the last store declaration
removes `patchy-shared-stores`, independently of the shared-table skill.
Connection setup, reconnection and credential forms are browser-only for admins;
no CLI command accepts connection secrets. A shared-source refusal names the
source-access repair path.

`patchy add members` accepts no target and its alias must remain `members`.
Config validation rejects a `t.member()` column without that declaration.
`remove members` checks the evaluated config before changing files and refuses
with local exit 1, `code: "invalid_manifest"`, while a member column exists.
A failed removal preserves the config, generated client and skills.
The declaration adds `patchy.members` on tier 1 and `ctx.members` in every
tier 2 handler kind. Refresh removes `patchy-members` when the declaration is
absent; it is not sticky. The directory declaration has no generated
stamp or metadata snapshot, and it does not provision a company database.

Managed package pins are `devDependencies.patchy`, the release's content-digest
tarball URL, and `devDependencies.workerd`, an exact version only on tier 2.
Refresh owns their updates, including adding or removing `workerd` after a tier
change. A changed tarball URL triggers installation even when the release
version string is unchanged. Installation disables lifecycle scripts; workerd
is spawned from its platform package rather than its postinstall-created
wrapper. Publish refuses a mismatched managed pin with `release_mismatch`.
There is no scaffold `pnpm.overrides`.

Other managed writes are the lockfile through install, `patchy/_generated/`,
`.agents/skills/patchy-*/`, fixture stubs only when absent, and one `uses` edit
for add/remove. Refresh removes stale generated context files. Existing
fixtures, app code and agent instructions are preserved. Refresh changes only
the managed dependency keys, preserving builder-owned keys and the surrounding
`package.json` bytes.
The CLI executes config locally and writes `manifest.json`; server generation
returns finished files, resolved declaration ids/revisions and typed declaration
metadata, never that manifest or production rows/credentials. Both sides constrain
paths to the managed roots; declaration snapshots are not generated repo files.
For tier 2, refresh enumerates one-level `server/*.ts` filename stems into
`serverModules`, independently of manifest handler descriptors. Generation uses
that list for type-only imports in the bound server helpers and client. It does
not load or bundle server code. Nested modules, invalid names and symbolic links
are local refusals; tiers 0 and 1 use an empty list and have no generated
`server.ts`. Refresh alone changes the generated module list after init; dev
and publish never repair it. Publish checks the list before bundling and
returns `stale_generated` for additions, removals or renames.
Skills are sticky: refresh re-fetches every present skill and adds config-implied
ones. `patchy-server` is the tier-keyed exception, removed below tier 2;
`patchy-members` is declaration-keyed, removed when `uses.members` is absent.
A different present skill no longer offered by the release fails refresh.
Their canonical source is `packages/sdk`.

Vite, `vite-plugin-singlefile`, TypeScript and `@types/node` belong to the builder.
Init writes caret ranges from `GET /api/release`'s `toolchain` metadata. Each entry
has `testedAgainst` and `accepted`; `packages/patchy/src/toolchain.json` supplies
the package build, scaffold and local checks from one set of version facts.
Dev and publish check the Vite module they load and the plugin modules resolved
while loading the builder's config, including imports through shared or nested
configs. A declared dependency range is not evidence of the installed version.
Versions outside the accepted ranges fail locally with `toolchain_unsupported`.
The current repair command is
`pnpm add --save-dev 'vite@^8.3.0' 'vite-plugin-singlefile@^2.3.3'`.
If a shared config resolves a separate installation, update it there too.
Refresh reports required upgrades as text notices and JSON `warnings`, but
never changes these builder-owned keys. It remains usable while the Vite config
is incomplete. TypeScript and declaration packages are scaffold metadata, not
additional dev/publish version gates.
The scaffold's ESLint packages are builder-owned lint defaults, not loaded by
dev or publish and not additional release compatibility gates. Hook lint
recognizes `useQuery` by its `use` prefix; it is not an effect callback with a
dependency array.

Dev and publish check reachable page imports before bundling can remove them.
The page entries are `patchy/preact`, its `jsx-runtime` and `jsx-dev-runtime`,
`patchy/csv`, and the relative generated client. `patchy/csv` ships CSV parsing
and stringification for both page and server code. Generated clients use
`patchy/client` internally. Tooling imports in config files and type-only imports are not page
dependencies. A bare package import fails with `import_refused` even if aliased
to a local file, or unused after tree shaking.
The check follows nested CSS imports and runtime module syntax before alias
rewriting. Relative paths into installed dependencies do not bypass it.
Vite's injected module-preload helper is tooling, not an authored page import.
Page imports from `server/` must be type-only.

### Local patch runtime

`patchy dev [--foreground]` is distinct from the cloud checkout's `pnpm dev`.
A healthy existing session returns before credentials or release checks. A new
start resolves a key; checks the exact pin, CLI and installed runtime release;
authenticates `/api/me`; pulls published inventory and declaration metadata;
regenerates; provisions local PGlite; and starts Vite build-watch with the
production shell, CSP, sandbox, broker and dispatcher. It uses fixtures and local
files, never production rows/bytes, Clerk, a connection keyring or the production
runtime log store. Each call logs viewer, handler, outcome and milliseconds, plus
`ctx.log` output and dev-only failure message/stack, without PostHog delivery.
A daemon started with `--json` writes full wide events and invocation JSON to
`dev.log`; `dev logs --json` still returns `{ ok, log, text }`.
Tier 0 retains its production shell policy with only the trusted local
reload script and polling endpoint added; its content remains script-free.
Tiers 1 and 2 return a second `colleagueUrl` at a distinct loopback origin,
authenticated as a fixed non-admin colleague in the same company. Both mounts
share data, fixtures and subscriptions; the primary remains the machine user.
Tier 2 uses the supervised workerd engine and private callback gateway.

`patchy dev` runs the same handler engine and callback path as production.
It does not reproduce production's scheduling, limits or containment. A handler
that spins forever times out, and a health check restarts the dev engine, which
can interrupt other calls in flight. Fixed contract limits remain enforced;
production operating capacity does not. PGlite is not evidence for hosted
`busy` or `write_conflict` behavior.

Shared-store fixtures live in `fixtures/shared-<alias>/`. Refresh creates only
missing directories, with `README.md` naming the source store and asking for
invented files. It never repairs or overwrites an existing fixture directory.
Dev reads bytes recursively on every start, skips the root README, and clears
the source store before loading its files. File deletions take effect on restart;
owned local files remain intact. Fixture bytes use `application/octet-stream`.
Both tiers consume the same source fixtures through real runtime handlers.
Edit fixtures and restart to change sources locally; authority changes are not simulated.

| command                 | `--json` success                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `dev`, `dev status`     | `{ ok, healthy: true, url, colleagueUrl?, logPath, stop, pid, release, identity, warnings }` |
| `dev stop`, `dev reset` | `{ ok, healthy: false, reset }`                                                              |
| `dev logs`              | `{ ok, log, text }`                                                                          |

Start exits 0 only after the first valid single-file bundle and runtime are
healthy. The daemon persists the checked release and full `/api/me` identity
(user, company, role, machine); healthy start/status report that session, not the
current login or release. `stop` is the executable repo-pinned
`pnpm patchy dev stop --api-url ...` command. Status without a healthy session is
local exit 1, `not_running`. Missing fixtures and local provisioning failures are
local; `not_additive` retains the provisioner's message/code. Instance refusals
and transport failures use the ordinary ladder.

Vite builds production bundles without HMR. A successful `src/` rebuild replaces
the page atomically and reloads the shell at its current route. A `server/` edit
atomically rebinds bundle bytes and descriptors without a reload. New modules are
discovered live with a log notice to refresh types. In-flight calls and nested
calls retain their old binding. Subscriptions wake on the new one and discard
results that cross the swap; removed handlers or incompatible arguments end
permanently. Failed rebuilds retain the last successful page or binding and log
the diagnostic. Config and fixture changes require stop/start. Foreground streams
logs in text mode; under `--json` it emits only readiness, leaving logs to
`dev logs --json`. Interruption stops only a session that invocation started.

State lives under `.patchy/dev/<instance-hash>/`, bound to canonical repo and
instance. Nonce-authenticated health and PID birth time identify the daemon;
stale records never signal another process. Malformed/incomplete records are
refused and left untouched, not reconstructed from today's login. Start, stop
and reset serialize with a key-addressed nonempty-directory owner record.
Reset stops and wipes all disposable local state without starting again.
The next start fetches the published inventory from the server; there is no local
baseline fallback. Before first publish, schema changes recreate local data;
afterwards cumulative published inventory is the additive baseline. Reset never
relaxes that baseline. A standalone Vite preview does not execute capabilities.

### Publish, sharing and lifecycle

`publish` and `/api/publish` are the sole publish verbs; `upload` and
`/api/uploads` were removed, not aliased.

| command                                                                                                                   | behaviour                                                                                                                                                                                               | `--json` success                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `patchy publish <file> [--name <name>] [--share company\|public] [--patch <id>] [--new] [--description <text>] [--force]` | Static file, tier 0, empty definitions/declarations; never reads `patchy.json`. Omitted description preserves the cloud value. `--patch` and `--new` conflict.                                          | Publish wire response including description, descriptionUpdatedAt and warnings.               |
| `patchy publish [--share company\|public] [--force]`                                                                      | Repo tier 0, 1 or 2; config name and `patchy.json` identity/description. Recover first, otherwise check release, description, generation, types, artifacts and tier. `--description` remains file-only. | Publish response with `artifacts.html`; tier 2 adds `artifacts.server` and sorted `handlers`. |
| `patchy share <file> <company\|public>` or `patchy share --patch <id> <company\|public>`                                  | Change sharing without a new version; exactly one file/cache or explicit-id target.                                                                                                                     | `{ ok, patchId, scope, publicUrl }`                                                           |
| `patchy retire [file] [--patch <id>] [--force]`                                                                           | Retire from live; dependants require force.                                                                                                                                                             | `{ ok, patchId, state: "retired", retiredAt }`                                                |
| `patchy delete [file] [--patch <id>] [--yes] [--force]`                                                                   | Delete from live or retired; confirm interactively unless `--yes`. Non-interactive without it is local exit 1. Forget file-cache entries only after success.                                            | `{ ok, patchId, state: "deleted", deletedAt, purgeAt }`                                       |
| `patchy restore [file] [--patch <id>] [--force]`                                                                          | Restore to live before `purgeAt`; off sources require force.                                                                                                                                            | `{ ok, patchId, state: "live" }`                                                              |
| `patchy rollback <n> [file] [--patch <id>]`                                                                               | Serve retained version n of a live patch, preserving data, sharing, description and name.                                                                                                               | `{ ok, patchId, currentVersion, address }`                                                    |
| `patchy describe "<text>" [--patch <id>]` or `patchy describe <file> "<text>"`                                            | Set a live or retired patch's description; normalized text and stamp rewrite `patchy.json` in repo mode.                                                                                                | `{ ok, patchId, description, descriptionUpdatedAt }`                                          |
| `patchy describe [file] --clear [--patch <id>]`                                                                           | Explicitly clear the description; empty and whitespace-only positionals are refused.                                                                                                                    | Same description response.                                                                    |

Inside a published repo, untargeted share, retire, delete, restore, rollback and
describe use `patchy.json`. An unpublished repo is a local refusal. A file and
`--patch` conflict; each verb uses the same per-instance file cache.
Only untargeted `describe` rewrites this repo's description and sync stamp.
An explicit file or `--patch` target does not mutate the local repo binding.
Delete leaves its repo id in place. A later publish returns `patch_deleted`
with `purgeAt`; preserve the id for restoration. Only a gone patch's 404
requires intentionally creating another patch.
On `publish`, `--name`, `--patch` and `--new` are file-mode flags; a failed repo build never
falls back to file mode. An unavailable cached file target likewise never
creates silently; use `--new`. Any machine key for the owner can manage the
patch; company membership or an admin role alone does not confer ownership.
Same-company non-owners receive `not_owner`; a retired or deleted target receives
`patch_retired` or `patch_deleted` on publish. Another company's target stays 404.

`has_dependants` and `sources_off` print the full list and end with "Ask the
person you are working for before forcing." `--force` accepts that breakage,
including an unshare at publish; `--yes` only confirms deletion.
`wrong_state` names the current state. A missing rollback version is
`version_unavailable`; invalid cloud description text is `invalid_description`.
These are `rejected`, exit 2. `not_owner` names the owner and asks them or an
admin to reassign it. Publish to an off patch says restore it or ask an admin;
`patch_deleted` carries its reclaim date. Restore past that date is refused
even if the deletion sweep has not run. None of these refusals suggests a new patch.

Fresh file publishes require the exact executing CLI release; repo publishes
and new dev starts also check the pin and installed runtime. A local mismatch
is exit 1 with `release_mismatch`, naming both releases and the repair: `pnpm patchy refresh` in a repo, the instance's install line for file publishing;
an instance refusal is exit 2 with the same code. Running dev and deployed
bundles survive tooling upgrades. Repo publish executes config only after the
release check and checks the generated release, manifest version, declaration
aliases/identities and resolved stamps in `patchy/_generated/index.json`.
`stale_generated` is local and names refresh. Definitions may change without
regeneration; publish writes the current manifest before the Vite single-file
build and import check, `tsc --noEmit`, and evident-tier check. Residual files/external resource
dependencies, an oversized HTML bundle (512 KiB at tier 0, 10 MiB at tiers 1 and 2,
`too_large` with largest contributors), `server/` below tier 2, or script at tier 0 fail
locally before attempt persistence. Compiler/build failures name the stage and
diagnostic command; raw tool output stays outside the failure envelope and
successful JSON stdout.

Bundle inspection is a resource-completeness gate, not a second safe-HTML
security policy. Resource dependencies must be embedded, scripts and styles
inline, and CSS `@import` is unsupported. Hyperlinks (fragment, relative and
external) have identical acceptance at tiers 0 and 1: they are navigation, not
missing bundle resources. The runtime sandbox still governs navigation.
Core's shared safe-HTML policy owns tier 0 safety.

A file publish onto cumulative table/store inventory is `has_primitives`
(422, exit 2, `rejected`), even if the current version omits every resource:
publish from its repo. Repo manifests may provision at tier 0, 1 or 2; tier is about
code. Additive refusals name each object, change and fix. A `patch_not_openable`
refusal means a declared shared source is unavailable; correct the declaration
or restore access. Postgres declarations must be connected at the current
generated metadata revision; reconnect on `/company/connections` or refresh
before a fresh attempt. The [definitive-refusal list](#definitive-publish-refusals)
specifies which wire responses clear the matching attempt.

Names are 3–32 lowercase letters, digits or hyphens, with neither end a hyphen.
An explicit name collision is `name_taken`. File creates without a name normalize
the filename, fall back to `patch` and append `-2`, `-3`, etc.; updates retain the
name unless renamed. Rename leaves a 308 redirect until another patch takes the
old name; retire and delete reserve every name until reclamation. Id or cached file selects the patch, never its
name. Addresses are `/<company>/<name>` and `/<company>/<name>/~v/<n>`.

New patches default to `company`; updates preserve scope unless `--share` sets
it. Only a public patch's current version is public, cached for at most 60 seconds
at both addresses. Older versions stay behind the company door; company origin
responses are `private, no-store`. Still-fresh public caches and downloaded copies
cannot be recalled. Tier 1 public patches expose the declared member directory
only to signed-in company members. Other company capabilities remain unavailable;
sharing publicly does not anonymously expose company data.

Tier 2 is company-only. `share --share public`, positional public sharing and the
portal scope form read the served version's tier, never local config, and answer
`tier2_not_public`, HTTP 422, exit 2. A tier 2 publish to a public patch must use
`--share company`. Rollback to a tier 2 version also requires company scope.
The refusal uses channel-neutral guidance to keep the patch company-scoped, not
a publish-only flag in sharing, rollback or portal responses.

Publish JSON always includes `artifacts: { html: { sha256, bytes } }`.
Tier 2 adds `artifacts.server: { sha256, bytes }` and
`handlers: [{ name, kind }]`, sorted by name. SHA-256 is lowercase hexadecimal;
bytes is the UTF-8 artifact size. The recovery slot retains both artifact bodies.
The manifest records descriptors and SDK entry points; server code is one closed
module without dynamic imports, separate from the HTML.

### The company look

| command                                     | behaviour                                                                                                                                                                      | `--json` success                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `patchy look`                               | Current revision's number, author, date, note and file sizes, then every revision newest first. Any member.                                                                    | Wire body `{ current \| null, revisions }`, with the files' contents, no `ok` wrapper. |
| `patchy look publish <dir> --note "<text>"` | Admins: check the folder's `look.css`, `LOOK.md` and optional `logo.svg`, publish them as the next revision and make it current. Other files are named in a warning, not sent. | `{ ok, current, warnings? }`                                                           |
| `patchy look restore <n\|none>`             | Admins: make revision `n` current, or leave the company with no look. Moves the pointer only.                                                                                  | `{ ok, current }`, `current` null for `none`                                           |
| `patchy look preview [<dir>] [--compare]`   | Write the specimen as one self-contained HTML file and print its path: in the folder's look, the company's look, or the folder beside the company's with `--compare`.          | `{ ok, path, failures, warnings? }`                                                    |

These commands run anywhere with the saved login; they never read `patchy.json`.
`look publish` runs `@patchy/core/look` before any request: a failing look is
`invalid_look`, local exit 1, its message one line per failure, and an empty or
over-long note is a local refusal too. The instance reruns the same checks, so
`invalid_look` from it is `rejected`, exit 2. A member's publish or restore is
`admin_required`, exit 2, with `admins` (`{ id, name }` each) in the failure
document so the agent can say who to ask. An unknown revision is
`revision_unavailable`, exit 2; restore accepts a positive integer or `none`,
anything else is local exit 1. The `Patchy-Cli` command is `look` for all four.

`look preview` writes `look-preview.html` in the state directory, replacing the
last preview, and never refuses a look it can read: `failures` holds every line
publish's `invalid_look` would list for the folder, empty when it would publish,
and the company's look is not checked. A folder alone sends no request and needs
no login; without a folder, or with `--compare`, it reads the current look as
`patchy look` does. `--compare` with no current look renders the folder alone
and says the company has no look yet. No folder and no current look, or
`--compare` without a folder, is local exit 1; a folder missing `look.css` or
`LOOK.md` is local exit 1 as for publish, and other files are `warnings`.

### Publish recovery

Each successful invocation publishes or recovers exactly one version. Before
fresh work, authenticate the selected key and recover its saved attempt for the
instance and mode. Recovery precedes today's file, cache, options, release and
build. The original owner is checked before sending saved content: a replacement
key for that user works; a different user fails locally and leaves the attempt.

The complete schema-encoded request, publish key, owner id, application target
and any local notices are persisted before sending. Recovery reports those
notices alongside the saved result. File attempts live at
`<stateDir>/publish/<instance-hash>/attempt/<key-hash>.json`; repo attempts use
`.patchy/publish/<instance-hash>/attempt/<key-hash>.json`. Both hashes are SHA-256.
A private staging directory holds an owner-only key-named payload written with
`wx`; atomic rename of the complete nonempty directory selects the attempt.
Concurrent invocations replay that selection rather than overwrite it and check
its owner even when losing the race. If it settles before the loser can read it,
the loser exits locally asking to run publish again. No separate stale-lock
recovery is needed. Killing a process leaves the selected attempt recoverable;
unselected staging data is never sent.

The server stores the response under a publish key unique to the user. Identical
retries return it, including after a release change; another payload under the
same key is `publish_key_conflict`. File recovery reapplies the original cache
entry, not a newly supplied file. Repo attempts store mode, not the original
absolute path, so a moved repo recovers at its current root. Creates and updates
record the returned patch id and description sync stamp in `patchy.json` before
clearing, preserving the stored instance spelling. A conflicting existing patch id or an instance
changed before result application fails locally and keeps the attempt;
publishing never rebinds the repo. Failed local application remains recoverable:
retry returns the saved result without building or creating another version.

Saved attempts may recover receipts written before description or artifact metadata existed.
Recovery validates the receipt's identity and application fields, accepts absent
description and artifact fields, and preserves the retained JSON without inventing metadata.
Fresh publishes still require the current response schema.

### Definitive publish refusals

After decoding a publish-route refusal, these responses clear only its matching
publish key (exit 2, `kind: "rejected"`), so the next publish builds a fresh
attempt. Any wire code is retained in the CLI's JSON failure document.

- **413**, regardless of code: reduce the payload.
- **422** with `release_mismatch`, `invalid_manifest`, `tier_mismatch`,
  `has_primitives`, `patch_not_openable`, `connection_not_connected`,
  `stale_generated`, `not_additive`, `reserved_name`, `invalid_description` or `tier2_not_public`,
  or any 422 carrying `errors`: repair the
  reported release, manifest, tier, inventory, declaration or HTML validation
  problem. File updates with inventory need repo publishing; non-additive
  changes must preserve the cumulative inventory.
- **409** with `publish_key_conflict` or `name_taken`: use a fresh attempt for
  the corrected payload, or choose another name.
- **403** with `not_owner`: preserve the patch id and ask its owner or an admin
  to reassign it. Never suggest creating another patch.
- **409** with `patch_retired` or `patch_deleted`: preserve the patch id and
  restore it before publishing. `patch_deleted` supplies the recovery deadline.
- **409** with `has_dependants`: ask the user before accepting the breakage.
  After approval, retry with `--force`; the saved refusal has been cleared.
- **404** on an update (the saved request has `patchId`) whose `error` is
  exactly `"Patch not found."`: the target is unavailable. Repo mode requires
  intentionally removing `patch` from `patchy.json` before a new create;
  cached-file mode uses `--new`, and `--patch` remains update-only.

Other responses, including authentication, throttling, quota and server failures,
do not establish the attempt's outcome and preserve it, as do unknown outcomes,
undecodable responses and failed local writes. Local refusals do not discard an
existing attempt. Clearing unlinks only that key's file, then removes only an
empty slot: a late K1 response cannot unlink K2's file or remove its nonempty
slot. Never discard an attempt merely because its outcome is unknown.

### The `Patchy-Cli` header

Every request a command sends to the instance carries
`Patchy-Cli: <release> <command> <agent>`, such as `0.0.1 publish claude-code`.
The command comes from `CliCommand` in `packages/api`; every command that
reaches the instance is in it. The agent is the first coding agent whose
harness variable is set, from `CodingAgent`, or `unknown`. No environment value
or free text is sent. The header feeds usage records only: no route requires
or answers it, so an instance that ignores it behaves the same. The
[README](../../packages/patchy/README.md#the-patchy-cli-header) lists the
variables.

### Signals and built-ins

SIGINT and SIGTERM interrupt the fiber and exit 130, not `128+n`. Effect's
non-echoing password prompt restores terminal mode on interruption. Built-ins
remain `--help`, `--version` (bare version string), `--completions`, `--wizard`
and `--log-level`; they do not introduce another command failure ladder.

## Consequences

**Branch on kinds and codes, not prose.** Messages explain the repair; exit code
and optional domain code determine the branch. Success documents distinguish a
completed act from a still-pending handoff or the identity of an existing daemon.

**Recovery and local authority remain explicit.** File cache, repo identity and
device state cannot silently rebind to another instance or user. The CLI's own
suites own its mapping against stub instances: exit codes, `--json` documents,
formatting and publish recovery (`cliPublish.test.ts`, `cliRepoRecovery.test.ts`),
with publish-key idempotency proven in `packages/patches`. The packed CLI flow
proves the installed artifact against a real server, one path per journey:
identity and login, and the init/dev/publish loop. Real-Postgres concurrency
checks cover races PGlite cannot demonstrate. [Development](../DEVELOPMENT.md)
owns the CI commands and their required checks.

## Alternatives considered

- **Effect's default 0/1/130.** Rejected: an agent cannot distinguish its call,
  the instance's policy and an unusable answer.
- **`128+n` for signals.** Rejected: Effect provides one interruption result and
  callers do not branch on the signal number.
- **Branching on refusal prose or retaining old command aliases.** Rejected:
  stable codes and one publish verb keep the agent contract unambiguous.
