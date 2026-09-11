# ADR-0004 — CLI contract for agents

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Publishing (`packages/patchy`). System-wide because the contract is what every agent driving the CLI — and the dev runner's `.local/dev/env` — is held to.
- **Source**: Effect v4 port spec (#68) §5; [CLI contract on Effect cli](https://github.com/allisonmahmood/patchy-cloud/issues/60#issuecomment-5456839739); [Local dev environment](https://github.com/allisonmahmood/patchy-cloud/issues/15) for instance precedence; build ticket #78; [auth spec §10](https://github.com/allisonmahmood/patchy-cloud/issues/135) and [login/logout](https://github.com/allisonmahmood/patchy-cloud/issues/142) for device login and credential precedence.

## Context

An agent is the CLI's primary driver, a developer a real secondary one. Both
read the same two things — the exit code and one stream — and act on them
without a human in the loop. Before the port the CLI exited 1 for everything,
so an agent could not tell its own mistake from the instance's refusal from a
network that was down, and it had to parse prose to find out. Moving the CLI
onto `effect/unstable/cli` was the moment to write the contract down.

## Decision

The npm package is `patchy` (formerly `@patchy/cli`), private until launch.
It owns the binary and `patchy/config`, `patchy/client`, `patchy/dev` at one
exact version, the release; see [ADR-0011](ADR-0011-one-package-one-release.md).
This rename does not change the command name or exit-code ladder.

### Exit codes: a ladder keyed by who has to act

| code | kind          | meaning                              | examples                                                                                                       |
| ---- | ------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 0    | ok            | the command's act succeeded          | login handoff or still pending; logout even when courtesy revocation fails                                     |
| 1    | `local`       | fixable without touching the network | bad args, file missing, HTML fails validation, no key, foreign login code, malformed state dir                 |
| 2    | `rejected`    | the instance answered and said no    | 401/403, 404 on an update, share or delete, 409, 413, 429, a server-side 400; denied, expired or unknown login |
| 3    | `unreachable` | no usable answer from the instance   | DNS/connect/timeout, 5xx, an unparseable body                                                                  |
| 130  | interrupted   | SIGINT/SIGTERM → fiber interruption  |                                                                                                                |

Nothing else. A defect (a bug, an unmodelled error) is one `Unexpected error:
<message>` line on stderr and exit 1, with the stack only at
`--log-level debug`. HTTP status maps to kind as 4xx → `rejected`, everything
that is not an answer — 5xx, connect, timeout, a body the wire schemas cannot
read — → `unreachable`: retry later, or contact Patchy support about the deployment.

A command whose local act succeeded reports a failed courtesy call as a warning,
never as an exit code. `logout` forgets the credential and pending login first;
failure to revoke that deleted key does not undo the local logout.

In code: one `CliError` union (`packages/patchy/src/CliError.ts`), each tag
carrying its `kind`, and a single table `exitCode(kind)`. Every command runs
under one wrapper (`Output.contract`) that renders a failure and fails with
its code; no command exits on its own.

### `--json`: a global flag on every command

- Success: stdout is exactly one JSON document. For `whoami`, `publish`, `share` and
  `delete` it is the wire shape from `@patchy/api`; `validate` prints `{ ok, warnings }`,
  `auth set` `{ ok, instanceUrl }`, `status` its report (its only format).
  Login's three success shapes and logout's shape are below. Warnings ride in the
  success document, never on stderr. Publish reports `name`, `address` and `scope`;
  `publicUrl` equals the address and remains on publish and share, not a promise of anonymous access.
- Failure: stderr is `{ "ok": false, "error": "<the one-line message>", "kind": "local" | "rejected" | "unreachable", "code"?: "<wire refusal code>" }`,
  stdout is empty, the exit code follows `kind`. Preserve the instance's `code`
  when present. A release mismatch detected before publishing is `local` with
  `code: "release_mismatch"`; the instance's release refusal is `rejected`.
- Stderr under `--json` carries failures only.

### Login, logout and identity

`patchy login [--complete [code]] [--wait <seconds>]` starts a device login with
`os.hostname()` as the machine-name hint. Re-login supplies the stored machine id
only for a credential saved by login; an `auth set`, environment or seeded key
has no saved login metadata to replace.
It blocks only when stdin is a terminal, `--json` is absent, and none of
`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CURSOR_AGENT`, `CODEX_SANDBOX`,
`CODEX_SANDBOX_NETWORK_DISABLED`, `GEMINI_CLI`, `OPENCODE`, `CLINE_ACTIVE`,
`AI_AGENT` or `CI` is set. A terminal alone cannot identify a human: an agent
may have a PTY while its tool buffers output until exit.

The human path prints the handoff and waits until the person answers or the
code expires. On a new login, every other path returns the URL, code, next
command and reason for not waiting, then exits 0. The agent relays the URL and
code, never opens a browser, and runs `next`, adding `--json` when it needs a
structured result: `next` retains an explicit instance override, not the output
flag. A non-blocking rerun with a pending login polls once, as chosen in
[#131](https://github.com/allisonmahmood/patchy-cloud/issues/131#issuecomment-5533101635):
it reports `pending`, `logged_in`, or a terminal refusal rather than another
handoff. The original URL/code remains valid until answered or expired.
An explicitly supplied `--api-url` is saved so later commands outside a worktree
can use the newly logged-in instance, matching `auth set`. It also stays
shell-quoted in `next` and the text `Then run` command: the dev env and
`PATCHY_API_URL` outrank saved config, so saving alone cannot preserve an override.

`--complete [code]` uses the pending login for the resolved instance; the code is
a separate argument (`--complete XXXX-XXXX`, not `--complete=XXXX-XXXX`).
A foreign code is `local` and names the live code. Polling follows the instance's
interval, adding five seconds after `slow_down`. The default wait is 60 seconds,
including in-flight responses and body decoding. An unanswered request at the
deadline is `unreachable` (exit 3): its outcome is unknown, and the local login
record is retained for the same completion command. A real pending answer
followed by exhaustion of the wait budget is success, not a timeout failure.
`--wait 0` is the explicit one-poll mode, waiting for that answer rather than
cancelling it immediately. Denied, expired and unknown are instance refusals
(exit 2), even when the local record already says expired: the poll lets the
instance report and consume it.
Completion saves the publishing key with `source: "login"` and
`machine: { id, name }`, forgets the pending login, and prints
`Logged in to <instance> as <company>. This machine is "<name>".`
The successful mint response carries the company/user receipt from the same
transaction; there is no fallible follow-up `/api/me` call after saving the
one-time key. Receipt and credential persistence finish even if local I/O runs
past the polling deadline.

When `PATCHY_API_TOKEN` is non-empty, successful login also prints “Login saved. PATCHY_API_TOKEN is still set and takes precedence over this login.” The JSON completion result includes this notice in `warnings` (an empty array without an override).

| command/result                             | `--json` success document                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`, handoff                           | `{ ok, status: "awaiting_confirmation", verificationUrl, verificationUrlBare, userCode, expiresAt, interval, next, agentNextSteps, notWaitingBecause }` |
| `login --complete` or rerun, still waiting | `{ ok, status: "pending", userCode, expiresAt, next, agentNextSteps }`                                                                                  |
| `login`, complete                          | `{ ok, status: "logged_in", instanceUrl, company: { handle, name }, user: { email }, machine: { id, name }, credentialsPath, warnings }`                |
| `logout`                                   | `{ ok, instanceUrl, revoked, warnings }`                                                                                                                |
| `whoami`                                   | `{ user: { id, email, name }, company: { id, handle, name }, role, machine: { id, name } }` (`Identity`, no `ok` wrapper)                               |

`patchy logout` deletes the stored credential and pending login before
`POST /api/logout` with only the token it just deleted. A 401 counts as
successful revocation; an unreachable instance produces exit 0 and the warning:
_Logged out on this machine. The key could not be revoked; it expires on its
own after 30 idle days, or revoke it now on Your machines._
It does not revoke a token selected from the environment or the dev seed.
With `PATCHY_API_TOKEN` set it warns that the publishing key from the environment
is not its to remove; in a worktree it says _This worktree's dev instance still publishes
with its seeded key_. JSON carries these in `warnings`, with `revoked`
reporting whether the deleted key was successfully revoked or already invalid.

`publish`, `delete`, `share`, `whoami` and the five patch-repo commands below
with no key exit 1 (`local`), `Run: patchy login`. No command starts a login
on the caller's behalf.

### One credential chain

Protected API commands and `status` resolve credentials in this order:
`PATCHY_API_TOKEN`, the credential stored for the resolved instance (`login` or
`auth-set`), then the seeded token when the instance came from the dev env.
A saved login therefore outranks the dev seed; logout exposes the seed again,
unless an environment token already overrides both. `status` uses that same
chain for `hasToken` and `tokenSource`: `login`, `auth-set`, or `null` for an
environment/dev-env key, an older stored entry without provenance, or no key.
Login reads the pending login and stored machine metadata instead; logout
revokes only the stored key it deleted, and `auth set` saves a supplied key.

State is per instance. `credentials.json` keeps the key and its provenance,
plus the machine for `source: "login"`. Owner-only `device-login.json` holds
one pending login per instance: device code, user code, both verification
URLs, polling interval and expiry. Neither the device code nor the publishing
key appears in the handoff or command output.

### Patch-repo commands

The repo is bound to one instance and one exact release. `init` authenticates
before creating files, installs once, and hands the builder a typechecking tree
with generated client, declaration context, project skills and fixture stubs.
Purpose, layout and the generated-index pointer live in write-once `AGENTS.md`;
`CLAUDE.md` imports it. Nothing identifying the person is committed.

| command                                                                                                     | behaviour                                                                                                                                                                                                                                                                               | `--json` success document                                                         |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `patchy init [dir] [--tier 0\|1] [--purpose <text>]`                                                        | Prints instance and identity, asks purpose interactively, lays down and installs a new repo, then generates. Default tier 1; an initialized target is refused. A company without connections gets empty declarations and core skills.                                                   | `{ ok, dir, release, tier, generated, skills, installed }`                        |
| `patchy refresh`                                                                                            | Fetches one release, changes the pin and installs if needed, re-execs its CLI, executes config and generates, then stages and activates the managed set transactionally. Failure leaves the old set intact.                                                                             | `{ ok, release: { from, to }, changed: { pin, generated, skills, fixtures } }`    |
| `patchy catalog [--all]`                                                                                    | Connected connections and openable shared tables, each with its `add` and `uses` line. Default text closes with a reminder about `--all`, which includes offered integrations and state.                                                                                                | Catalog wire response `{ connections, sharedTables, offered? }`, no `ok` wrapper. |
| `patchy add postgres/<handle> [--as <alias>]` or `patchy add shared-table <patchId>/<table> [--as <alias>]` | One literal TypeScript AST insertion into `uses` without import changes, then generation. An uneditable expression fails with its exact source line and the exact declaration line to add manually before refresh. Refusals identify the connection/admin or source-access repair path. | `{ ok, alias, declaration, generated, skills }`                                   |
| `patchy remove <alias>`                                                                                     | Removes the declaration, its generated surface and the declaration skill when no declaration of that kind remains; keeps the fixture and says so.                                                                                                                                       | `{ ok, alias, removed }`                                                          |

`patchy add postgres` selects the sole connected Postgres connection, lists
copy-ready handle choices and stops when several exist, or names
`/company/connections` when none exists. Postgres aliases default to the handle
with hyphens camel-cased; shared-table aliases default to the table name.
`--as` overrides either. Init's target must be empty or absent under an existing
parent; purpose is required explicitly for agent, JSON and non-terminal calls,
and otherwise asked at the terminal. There is no inferred purpose.

Only these files are managed: the pin, `patchy/_generated/`,
`.agents/skills/patchy-*/`, missing fixture stubs, the lockfile through install,
and one `uses` edit for add/remove. Existing fixtures belong to the builder.
The CLI executes config locally and writes `manifest.json`; generation receives
the manifest and returns finished files plus resolved ids and revision stamps,
never that manifest file. Both sides constrain output paths to the managed roots.

Project skill presence is sticky: refresh updates every present skill and adds
config-implied ones without deleting skills. A present skill no longer offered
by the release fails refresh. Only explicit removal may retire a declaration's
skill when no use of that kind remains. Their canonical source is `packages/sdk`,
not a hand-maintained copy in each patch.

`--json` uses the same failure envelope and exit-code ladder above, preserving
`connection_not_connected`, `patch_not_openable` and `release_mismatch` from the
instance. `init` with no key is a local error before creating a repo, including
in non-interactive execution. Pass `--purpose` for unattended initialization.
No install or generation progress leaks into JSON stdout.

The tree teaches “test with `patchy dev`”, but that local runtime remains separate
work. Repo publishing builds for the hosted broker; a standalone Vite preview
cannot execute declared capabilities.

### Publishing and sharing commands

| command                                                                                  | behaviour                                                                                                                                                                                                                              | `--json`                                                                                                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `patchy publish <file> [--name <name>] [--share company\|public] [--patch <id>] [--new]` | Synthesises a tier 0 manifest and publishes the file. A new patch defaults to `company`; an update preserves its scope without the flag. `--patch` only updates; `--new` bypasses the file cache to create.                            | The publish wire response, including `name`, `address`, `scope`, `tier`, `schemaRevision`, `provisioned` and `unused`. |
| `patchy publish [--share company\|public]`                                               | Publishes the repo at tier 0 or 1, using the config name and `patchy.json` id. Recovers its saved attempt first; otherwise checks release, declarations, types, bundle and tier before sending.                                        | The same publish wire response.                                                                                        |
| `patchy share <file> <company\|public>` or `patchy share --patch <id> <company\|public>` | Changes sharing without publishing a version. Select the file's cached patch or an explicit id, exactly one, as `delete` does. Only the owner may change it; an unavailable or unowned patch answers 404. With no key, exit 1 `local`. | `{ ok: true, patchId, scope, publicUrl }`.                                                                             |

Inside a repo, `patchy share company|public` and `patchy delete` use the id in
`patchy.json`; an unpublished repo is a local refusal. Delete leaves that id in
place. Publishing to a deleted patch returns 404 (exit 2), with the instruction
to remove `patch` from `patchy.json` before intentionally creating another patch.
`--name`, `--patch` and `--new` belong to file mode; repo identity comes from its
config and `patchy.json`, and file mode is never a fallback for a failed repo build.

Repo publish checks the exact pin, executing CLI and installed runtime against
the release before executing config. The generated index's release and manifest
version must be current; declaration aliases, identities and resolved stamps must
match `patchy/_generated/index.json`. Local `stale_generated` is exit 1:
“declarations changed; run `patchy refresh`”. Then `tsc --noEmit`, Vite's single-file
build and the evident tier check run. Residual files/dependencies, a bundle over
10 MiB (with largest contributors), `server/`, or script under a tier 0 claim
fail locally before persistence or publishing. Compiler/build failures name the
stage and a local diagnostic command; raw tool output stays out of the failure
envelope and successful JSON stdout.

Repo attempts live at `.patchy/publish/<instance-hash>/attempt/<key-hash>.json`,
using the same atomic selection and key-addressed clearing as file mode.
They store repo mode, not an absolute repo path: recovery applies and clears
against the root holding the attempt, including after moving it. Both creates
and updates record the resolved instance and returned patch id in `patchy.json`
before clearing. An existing conflicting instance/patch pair is a local refusal
that retains the attempt. Failed local application remains recoverable; retry
returns that result without building or creating another version.

File publishing never reads `patchy.json`. The executing CLI must match
`GET /api/release` exactly; a mismatch names both releases and `patchy refresh`.
Repo publishing also checks the repo pin and installed runtime release;
each must be exact-current, not a compatible version range. Local dev starts
remain separate work; refresh upgrades the pin and generated set.
File publishing onto a patch with cumulative table or store inventory is
`has_primitives` (422, exit 2, `rejected`), even if its current version omits
those definitions. Publish that patch from its repo. `has_primitives`,
`not_additive`, `patch_not_openable`, `connection_not_connected` and
`stale_generated` clear the matching refused attempt (422, exit 2);
they retain their wire codes in the CLI's JSON failure document. A
`patch_not_openable` refusal means a declared shared source is unavailable;
correct the declaration or restore source access before starting a fresh attempt.
A Postgres connection must still be connected with the generated snapshot revision.
Reconnect it through `/company/connections` or regenerate the declaration before retrying.
The connect and credential forms are browser-only; no CLI command accepts connection secrets.

Every patch opens at `/<company>/<name>`; a version at `/<company>/<name>/~v/<n>`.
`--name` sets or renames it using 3–32 lowercase letters, digits or hyphens, without
leading or trailing hyphens. An explicit name already held by another patch is
`name_taken` (409, exit 2, `rejected`); it clears the definitive refused attempt so
the caller can choose another name. Without the flag, a create derives a name from
the filename, normalises it, falls back to `patch` when unusable, and adds `-2`,
`-3`, and so on for collisions. An update preserves its current name. Rename leaves
a 308 redirect until another patch takes the old name; deleting frees every name.
The id or cached file, never the name, selects which patch is updated.

Before a request, the CLI authenticates the publishing key and schema-encodes the
complete attempt (publish key, request body, owner user ID and application target).
It writes `<sha256(publishKey)>.json` with `wx` in a private staging directory, then
atomically renames the nonempty directory into the instance's `attempt/` slot.
An occupied nonempty slot cannot be replaced: concurrent invocations read and
resend its attempt, checking its owner even after losing the rename race.
On the next `publish`, the CLI authenticates again and
requires the original owner before sending any saved content. Replacement machine
tokens for that same owner work; a different owner is a local refusal and leaves
the attempt intact. Recovery precedes reading the file, validating new options or
checking the release. Success updates the cache, clears only the matching publish key
and prints the recovered result; no additional version is published.

A decoded publish-route 413 and other definitive payload refusals clear only the
matching publish key. Authentication, throttling and quota refusals do not establish
its outcome; they preserve the attempt, as do unknown outcomes and failed local
writes. Clearing unlinks only the key-addressed payload, then removes the slot only
if empty. Even if another sender installs K2 while a K1 response is clearing,
K1 cannot unlink K2's file and an empty-directory removal cannot remove K2's
nonempty slot. No separate lock or stale-lock recovery is needed. Killing a process
leaves any selected attempt recoverable; an unselected staging directory is never sent.

The server stores the response under a publish key unique to the owning user.
An identical retry returns that response even after the current release changes;
a different payload with the same key is `publish_key_conflict` (409).

Only the current version of a public patch is public; older versions stay behind
the company door and are read through the user's signed-in browser. The current
public version caches for at most 60 seconds at both its latest and version URLs.
Older versions, and all versions after changing to company, have origin responses
of `private, no-store`; already downloaded copies and still-fresh public cache
entries cannot be recalled.

### `--api-url`: a global flag feeding one `Instance` service

Resolution order: `--api-url` > `.local/dev/env` (searched upward from the
working directory) > `PATCHY_API_URL` > `~/.patchy/config.json` > the local
default. For repo commands (`refresh`, `catalog`, `add`, `remove`, no-file
`publish`, untargeted `share`/`delete` and private generation), `patchy.json`'s
instance comes after `PATCHY_API_URL` and before saved config. `init` and
file-oriented commands keep the order above. One service
resolves the URL once per command and exposes its source (`flag` | `dev-env` |
`env` | `project` | `config` | `default`); `status --json` reports its resolved
URL and source, and `publish` prints "Publishing to <url> (target came from …)"
in text mode. A worktree with a running `pnpm dev` instance is the one place
an agent should never have to say where to publish, which is why the dev env
outranks the environment variable.

### Signals

Effect's mapping: SIGINT and SIGTERM interrupt the fiber and exit 130 — no
`128+n`. The hidden-token prompt is Effect's `Prompt.password`, whose terminal
raw mode is a scope finalizer, so interruption restores the terminal by
construction.

### Built-ins

Effect's stay: `--help`, `--version` (the bare version string),
`--completions`, `--wizard`, `--log-level`. They are conveniences for the
developer and never change what an agent sees. The output formatter is
narrowed to one-line errors and the bare version.

## Consequences

**An agent branches on the exit code, not on prose.** 1 means fix the call or
the file, 2 means the instance's policy stands, 3 means try later or contact
Patchy support. The messages stay for humans and for the JSON `error` field.

**Contract and mechanism separate in the packed-CLI e2e.** The e2e asserts
the ladder, one-line stderr, the bare `--version`, the token never in argv or
output, and the `--json` shapes. Its 130/143 signal probes test the harness's
own temp-root cleanup and stay harness tests; the CLI's old readline and
raw-mode choreography is gone with the prompt it served.

**A parse error still prints usage.** Effect renders help on stdout before the
error line when arguments do not parse; the error itself is one stderr line
(one document under `--json`) and the exit code is 1. Agents reading stdout
under `--json` should treat a non-zero exit as "stdout is not the document".

## Alternatives considered

- **Effect's default 0/1/130.** Rejected: agents building patches need to know
  at a glance whether the mistake is theirs, the instance's, or the network's.
- **`128+n` for signals.** Rejected: Effect's interruption already gives one
  code for both signals, and nothing branches on which one.
- **Branching on refusal prose.** Rejected: `code` identifies machine-actionable
  refusals independently of the human message; `kind` still identifies who acts.
