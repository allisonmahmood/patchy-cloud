# ADR-0004 — CLI contract for agents

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Publishing (`packages/cli`). System-wide because the contract is what every agent driving the CLI — and the dev runner's `.local/dev/env` — is held to.
- **Source**: Effect v4 port spec (#68) §5; [CLI contract on Effect cli](https://github.com/allisonmahmood/patchy-cloud/issues/60#issuecomment-5456839739); [Local dev environment](https://github.com/allisonmahmood/patchy-cloud/issues/15) for instance precedence; build ticket #78; [auth spec §10](https://github.com/allisonmahmood/patchy-cloud/issues/135) and [login/logout](https://github.com/allisonmahmood/patchy-cloud/issues/142) for device login and credential precedence.

## Context

An agent is the CLI's primary driver, a developer a real secondary one. Both
read the same two things — the exit code and one stream — and act on them
without a human in the loop. Before the port the CLI exited 1 for everything,
so an agent could not tell its own mistake from the instance's refusal from a
network that was down, and it had to parse prose to find out. Moving the CLI
onto `effect/unstable/cli` was the moment to write the contract down.

## Decision

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
read — → `unreachable`: "retry later, or tell the operator" is one action.

A command whose local act succeeded reports a failed courtesy call as a warning,
never as an exit code. `logout` forgets the credential and pending login first;
failure to revoke that deleted key does not undo the local logout.

In code: one `CliError` union (`packages/cli/src/CliError.ts`), each tag
carrying its `kind`, and a single table `exitCode(kind)`. Every command runs
under one wrapper (`Output.contract`) that renders a failure and fails with
its code; no command exits on its own.

### `--json`: a global flag on every command

- Success: stdout is exactly one JSON document. For `whoami`, `upload`, `share` and
  `delete` it is the wire shape from `@patchy/api`; `validate` prints `{ ok, warnings }`,
  `auth set` `{ ok, instanceUrl }`, `status` its report (its only format).
  Login's three success shapes and logout's shape are below. Warnings ride in the
  success document, never on stderr. Upload and share report `scope`; the field name
  `publicUrl` alone does not imply anonymous access.
- Failure: stderr is `{ "ok": false, "error": "<the one-line message>", "kind": "local" | "rejected" | "unreachable" }`,
  stdout is empty, the exit code follows `kind`. The same shape as the
  server's 401 body, plus `kind`. No `code` field until an agent flow branches
  on one.
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

| command/result                             | `--json` success document                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`, handoff                           | `{ ok, status: "awaiting_confirmation", verificationUrl, verificationUrlBare, userCode, expiresAt, interval, next, agentNextSteps, notWaitingBecause }` |
| `login --complete` or rerun, still waiting | `{ ok, status: "pending", userCode, expiresAt, next, agentNextSteps }`                                                                                  |
| `login`, complete                          | `{ ok, status: "logged_in", instanceUrl, company: { handle, name }, user: { email }, machine: { id, name }, credentialsPath }`                          |
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

`upload`, `delete`, `share` and `whoami` with no key exit 1 (`local`),
`Run: patchy login`. No command starts a login on the caller's behalf.

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

### Publishing and sharing commands

| command                                                                                  | behaviour                                                                                                                                                                                                                                                                                               | `--json`                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `patchy upload <file> [--share company\|public] …`                                       | A new patch defaults to `company`; an update preserves its scope without the flag, and an explicit flag sets it either way. Text output names the scope and who can open the link.                                                                                                                      | The upload wire response, including `scope`. |
| `patchy share <file> <company\|public>` or `patchy share --patch <id> <company\|public>` | Changes sharing without publishing a version. Select the file's cached patch or an explicit id, exactly one, as `delete` does. Only the owner may change it; an unavailable or unowned patch answers 404. Text output names who can open the link. With no key, exit 1 `local`, like upload and delete. | `{ ok: true, patchId, scope, publicUrl }`.   |

Company pages are read through the user's signed-in browser; only public pages
fetch by URL. Both latest and version URLs cache a public response for at most
60 seconds; changing to company makes origin responses `private, no-store`,
but cannot recall an already downloaded copy or a still-fresh public cache entry.

### `--api-url`: a global flag feeding one `Instance` service

Resolution order: `--api-url` > `.local/dev/env` (searched upward from the
working directory) > `PATCHY_API_URL` > `~/.patchy/config.json` > the local
default. One service resolves it once per command and exposes the URL and its
source (`flag` | `dev-env` | `env` | `config` | `default`); `status --json`
reports both, and `upload` prints "Publishing to <url> (target came from …)"
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
the file, 2 means the instance's policy stands, 3 means try later or tell the
operator. The messages stay for humans and for the JSON `error` field.

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
- **A `code` field in the JSON failure.** Deferred until a flow branches on it;
  `kind` and the exit code carry the same information today.
