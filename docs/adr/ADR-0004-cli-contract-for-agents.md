# ADR-0004 — CLI contract for agents

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Publishing (`packages/patchy`). System-wide because every agent driving the CLI and the cloud worktree's dev runner depend on this contract.
- **Source**: Effect v4 port spec (#68) §5; [CLI contract on Effect cli](https://github.com/allisonmahmood/patchy-cloud/issues/60#issuecomment-5456839739); [Local dev environment](https://github.com/allisonmahmood/patchy-cloud/issues/15); [auth spec §10](https://github.com/allisonmahmood/patchy-cloud/issues/135); [SDK map decisions](https://github.com/allisonmahmood/patchy-cloud/issues/164) and [SDK spec §§7–8, 13–14](https://github.com/allisonmahmood/patchy-cloud/issues/193).

## Context

An agent is the CLI's primary driver, a developer a real secondary one. Both
need to distinguish a mistake in the call from an instance refusal and an
unusable network answer without parsing prose. Repo generation, detached dev and
recoverable publish add commands, not alternative output or identity conventions.

## Decision

One npm package, `patchy`, owns the binary and `patchy/config`, `patchy/client`
and `patchy/dev` at one exact release. It remains private and is distributed by
the instance until launch. Inside a patch repo, `pnpm patchy` runs the pinned
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
- **Failure:** one stderr document `{ ok: false, error, kind, code? }`, ordinarily
  empty stdout, and the exit code for `kind`. `code` preserves exposed wire
  refusals and identifies [local repo checks](#local-repo-refusal-codes), plus
  local dev codes such as `not_additive` and `not_running`; not every error has one.
  Terminal device-login refusals currently use `kind` and `error` without a code.
- **Parse errors:** Effect may print usage to stdout before the failure document.
  Check the exit code before parsing stdout as success. Built-ins such as help
  and the bare `--version` retain their own output, not success envelopes.

`whoami`, `publish`, `share` and `delete` expose their API success shapes;
[API reference](../API.md) owns those fields. `publicUrl` on publish/share is an
address, not a promise of anonymous access: `scope` decides who can open it.

### Local repo refusal codes

Branch on the exit code and `kind` first, then on `code` when present. These
local repo checks use exit 1 and `kind: "local"`; the same code received from the
instance is `rejected` (exit 2). Not every local failure has a structured code
(for example, compiler, bundle-completeness and local I/O errors).

| `code`              | Meaning and remedy                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_mismatch` | The effective target differs from the repo's stored instance, or the stored instance changed before result application. The diagnostic names both URLs. Remove or correct the effective override to match the repo; restore an unintended late target edit before recovery. Never remove the patch id or rebind the instance to bypass this refusal. |
| `release_mismatch`  | The repo pin, executing CLI or installed runtime differs from the instance release. Run `pnpm patchy refresh` in the repo; file mode installs the exact package from `GET /api/release`.                                                                                                                                                             |
| `stale_generated`   | Generated release metadata or declaration stamps no longer match the config. Run `pnpm patchy refresh`.                                                                                                                                                                                                                                              |
| `invalid_manifest`  | Config execution or manifest decoding failed. Fix `patchy.config.ts` and its imports/declarations before publishing.                                                                                                                                                                                                                                 |
| `too_large`         | The HTML bundle exceeds its tier's local cap: 512 KiB at tier 0, 10 MiB at tier 1. Reduce the resources named in the largest-contributor report; size alone is not a tier mismatch.                                                                                                                                                                  |
| `tier_mismatch`     | The evident capabilities do not fit the declared or supported tier. Remove unsupported server code/tier 2+, or use tier 1 for browser code; at tier 0 correct the reported core static-HTML policy violations.                                                                                                                                       |

### Instance, credentials and local state

For `init` and file-oriented commands, the instance is resolved once per command:

`--api-url` > nearest upward `.local/dev/env` > `PATCHY_API_URL` > saved config >
`http://localhost:3000`.

For repo commands (`refresh`, `catalog`, `add`, `remove`, `dev` and its
subcommands, no-file `publish`, untargeted `share`/`delete`, and private
generation), the instance stored in `patchy.json` is authoritative. Select the
effective override from `--api-url` > `.local/dev/env` > `PATCHY_API_URL`.
If present, it must match the stored URL after normalization; a mismatch is
`instance_mismatch` before any HTTP request, naming both targets. Ignored
lower-precedence settings cannot cause a mismatch. With no override, the repo
instance wins over saved config and the default. A matching override retains
its URL source and credential behavior. `init` and file mode do not read this
repo binding. Correct the effective override rather than deleting the patch id
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
| `patchy validate <file>`                            | Check the static-HTML policy without publishing or authenticating.                                                                                                                                                                       | `{ ok, warnings }`                                                                                                       |

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

### Patch-repo commands and managed files

| command                                                                                                     | behaviour                                                                                                                                                                                                                | `--json` success                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `patchy init [dir] [--tier 0\|1] [--purpose <text>]`                                                        | Authenticate first, print instance/identity, ask purpose only at a human terminal, stage a new repo, install and generate before activating it. Default tier 1; target must be empty or absent under an existing parent. | `{ ok, dir, release, tier, generated, skills, installed }`                       |
| `patchy refresh`                                                                                            | Fetch one release, update/install the pin if needed, re-exec that CLI before config execution, generate and activate the managed set transactionally. Failure leaves the previous set intact.                            | `{ ok, release: { from, to }, changed: { pin, generated, skills, fixtures } }`   |
| `patchy catalog [--all]`                                                                                    | Connected connections and openable shared tables, with copy-ready `add` and `uses` lines. `--all` includes offered integrations and state; default text reminds the caller it exists.                                    | Catalog wire response `{ connections, sharedTables, offered? }`, no `ok` wrapper |
| `patchy add postgres/<handle> [--as <alias>]` or `patchy add shared-table <patchId>/<table> [--as <alias>]` | Insert a literal declaration into `uses` by TypeScript AST without import changes, then generate client, context, missing fixture and skill.                                                                             | `{ ok, alias, declaration, generated, skills }`                                  |
| `patchy remove <alias>`                                                                                     | Remove the declaration and its generated surface; remove the declaration skill only when no declaration of that kind remains. Keep the fixture and say so.                                                               | `{ ok, alias, removed }`                                                         |

Agent, JSON and non-terminal `init` calls require `--purpose`; purpose is never
inferred. A company with no connections gets empty `uses` and core skills. The
tree includes `patchy.config.ts`, `patchy.json`, the package pin and lockfile,
app/build/typecheck sources, generated client and declaration metadata, project
skills and fixtures. Write-once `AGENTS.md` records purpose, layout, completed
installation, the generated index and `patchy dev`; `CLAUDE.md` imports it.
The tree typechecks without more setup. Nothing identifying the person is committed.

`patchy add postgres` chooses the sole connected Postgres connection; with
several it lists copy-ready choices and stops, and with none it names
`/company/connections`. Default aliases camel-case Postgres handle hyphens or use
the shared table name; `--as` overrides either. An uneditable `uses` expression
fails with the exact source line and declaration line to add before refresh.
Connection setup, reconnection and credential forms are browser-only for admins;
no CLI command accepts connection secrets. A shared-source refusal names the
source-access repair path.

Managed writes are the pin, lockfile through install, `patchy/_generated/`,
`.agents/skills/patchy-*/`, fixture stubs only when absent, and one `uses` edit
for add/remove. Existing fixtures, app code and agent instructions are preserved.
The CLI executes config locally and writes `manifest.json`; server generation
returns finished files, resolved declaration ids/revisions and typed declaration
metadata, never that manifest or production rows/credentials. Both sides constrain
paths to the managed roots; declaration snapshots are not generated repo files.
Skills are sticky: refresh re-fetches every present skill and adds config-implied
ones, never deleting on its own. A present skill no longer offered by the release
fails refresh. Their canonical source is `packages/sdk`.

### Local patch runtime

`patchy dev [--foreground]` is distinct from the cloud checkout's `pnpm dev`.
A healthy existing session returns before credentials or release checks. A new
start resolves a key; checks the exact pin, CLI and installed runtime release;
authenticates `/api/me`; pulls published inventory and declaration metadata;
regenerates; provisions local PGlite; and starts Vite build-watch with the
production shell, CSP, sandbox, broker and dispatcher. It uses fixtures and local
files, never production rows/bytes, Clerk, a connection keyring or runtime call
logging. The same dispatcher admits calls and bytes routes without logging dev
calls. Tier 0 retains its production shell policy with only the trusted local
reload script and polling endpoint added; its content remains script-free.

| command                 | `--json` success                                                    |
| ----------------------- | ------------------------------------------------------------------- |
| `dev`, `dev status`     | `{ ok, healthy: true, url, logPath, stop, pid, release, identity }` |
| `dev stop`, `dev reset` | `{ ok, healthy: false, reset }`                                     |
| `dev logs`              | `{ ok, log, text }`                                                 |

Start exits 0 only after the first valid single-file bundle and runtime are
healthy. The daemon persists the checked release and full `/api/me` identity
(user, company, role, machine); healthy start/status report that session, not the
current login or release. `stop` is the executable repo-pinned
`pnpm patchy dev stop --api-url ...` command. Status without a healthy session is
local exit 1, `not_running`. Missing fixtures and local provisioning failures are
local; `not_additive` retains the provisioner's message/code. Instance refusals
and transport failures use the ordinary ladder.

Vite builds production bundles without HMR. Successful rebuilds replace the
bundle atomically and reload the whole shell at the current route; failures keep
the last successful bundle and log the diagnostic. Config and fixture changes
require stop/start. Foreground streams logs in text mode; under `--json` it emits
only readiness, leaving logs to `dev logs --json`. Interruption stops the session
only if that foreground invocation started it.

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

### Publish, sharing and deletion

`publish` and `/api/publish` are the sole publish verbs; `upload` and
`/api/uploads` were removed, not aliased.

| command                                                                                  | behaviour                                                                                                                                                                                                           | `--json` success                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `patchy publish <file> [--name <name>] [--share company\|public] [--patch <id>] [--new]` | Static file, tier 0, empty definitions/declarations; never reads `patchy.json`. Update the cached file patch unless `--new` creates or `--patch` selects an update-only target. Those flags are mutually exclusive. | Publish wire response, including name/address, scope, tier, version, schemaRevision, provisioned, unused and warnings |
| `patchy publish [--share company\|public]`                                               | Repo tier 0 or 1, config name and `patchy.json` identity. Recover first; otherwise check release, generation, types, bundle and tier before sending.                                                                | Same publish wire response                                                                                            |
| `patchy share <file> <company\|public>` or `patchy share --patch <id> <company\|public>` | Change sharing without a new version; exactly one file/cache or explicit-id target.                                                                                                                                 | `{ ok, patchId, scope, publicUrl }`                                                                                   |
| `patchy delete <file>` or `patchy delete --patch <id>`                                   | Delete an owned patch; confirm with the user first. Forget matching file-cache entries only after success.                                                                                                          | `{ ok }`                                                                                                              |

Inside a published repo, `patchy share company|public` and `patchy delete` use
`patchy.json` without another target. An unpublished repo is a local refusal.
Delete leaves its repo id in place: a later publish returns 404 and says to
remove `patch` from `patchy.json` before intentionally creating another patch.
`--name`, `--patch` and `--new` are file-mode flags; a failed repo build never
falls back to file mode. An unavailable cached file target likewise never
creates silently; use `--new`. Any machine key for the owner can manage the
patch; company membership or an admin role alone does not confer ownership.
Unknown, unavailable and unowned targets share the generic 404 door.

Fresh file publishes require the exact executing CLI release; repo publishes
and new dev starts also check the pin and installed runtime. A local mismatch
is exit 1 with `release_mismatch`, naming both releases and `patchy refresh`;
an instance refusal is exit 2 with the same code. Running dev and deployed
bundles survive tooling upgrades. Repo publish executes config only after the
release check and checks the generated release, manifest version, declaration
aliases/identities and resolved stamps in `patchy/_generated/index.json`.
`stale_generated` is local and names refresh. Definitions may change without
regeneration; publish writes the current manifest before `tsc --noEmit`, the
Vite single-file build and evident-tier check. Residual files/external resource
dependencies, an oversized bundle (512 KiB at tier 0, 10 MiB at tier 1, both
`too_large` with largest contributors), `server/`, or script at tier 0 fail
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
publish from its repo. Repo manifests may provision at tier 0 or 1; tier is about
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
old name; delete frees every name. Id or cached file selects the patch, never its
name. Addresses are `/<company>/<name>` and `/<company>/<name>/~v/<n>`.

New patches default to `company`; updates preserve scope unless `--share` sets
it. Only a public patch's current version is public, cached for at most 60 seconds
at both addresses. Older versions stay behind the company door; company origin
responses are `private, no-store`. Still-fresh public caches and downloaded copies
cannot be recalled. Tier 1 public patches have no company capabilities, even for
signed-in members; sharing publicly does not anonymously expose their resources.

### Publish recovery

Each successful invocation publishes or recovers exactly one version. Before
fresh work, authenticate the selected key and recover its saved attempt for the
instance and mode. Recovery precedes today's file, cache, options, release and
build. The original owner is checked before sending saved content: a replacement
key for that user works; a different user fails locally and leaves the attempt.

The complete schema-encoded request, publish key, owner id and application target
are persisted before sending. File attempts live at
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
record only the returned patch id in `patchy.json` before clearing, preserving
the stored instance spelling. A conflicting existing patch id or an instance
changed before result application fails locally and keeps the attempt;
publishing never rebinds the repo. Failed local application remains recoverable:
retry returns the saved result without building or creating another version.

### Definitive publish refusals

After decoding a publish-route refusal, these responses clear only its matching
publish key (exit 2, `kind: "rejected"`), so the next publish builds a fresh
attempt. Any wire code is retained in the CLI's JSON failure document.

- **413**, regardless of code: reduce the payload.
- **422** with `release_mismatch`, `invalid_manifest`, `tier_mismatch`,
  `has_primitives`, `patch_not_openable`, `connection_not_connected`,
  `stale_generated` or `not_additive`, or any 422 carrying `errors`: repair the
  reported release, manifest, tier, inventory, declaration or HTML validation
  problem. File updates with inventory need repo publishing; non-additive
  changes must preserve the cumulative inventory.
- **409** with `publish_key_conflict` or `name_taken`: use a fresh attempt for
  the corrected payload, or choose another name.
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
device state cannot silently rebind to another instance or user. The packed CLI
flow exercises command documents, identity, recovery and the init/dev/publish
loop; real-Postgres concurrency checks cover races PGlite cannot demonstrate.
[Development](../DEVELOPMENT.md) owns the CI commands and their required checks.

## Alternatives considered

- **Effect's default 0/1/130.** Rejected: an agent cannot distinguish its call,
  the instance's policy and an unusable answer.
- **`128+n` for signals.** Rejected: Effect provides one interruption result and
  callers do not branch on the signal number.
- **Branching on refusal prose or retaining old command aliases.** Rejected:
  stable codes and one publish verb keep the agent contract unambiguous.
