# ADR-0004 — CLI contract for agents

- **Status**: Accepted
- **Date**: 2026-08-29
- **Contexts**: Publishing (`packages/cli`). System-wide because the contract is what every agent driving the CLI — and the dev runner's `.local/dev/env` — is held to.
- **Source**: Effect v4 port spec (#68) §5; [CLI contract on Effect cli](https://github.com/allisonmahmood/patchy-cloud/issues/60#issuecomment-5456839739); [Local dev environment](https://github.com/allisonmahmood/patchy-cloud/issues/15) for the precedence; build ticket #78.

## Context

An agent is the CLI's primary operator, a developer a real secondary one. Both
read the same two things — the exit code and one stream — and act on them
without a human in the loop. Before the port the CLI exited 1 for everything,
so an agent could not tell its own mistake from the instance's refusal from a
network that was down, and it had to parse prose to find out. Moving the CLI
onto `effect/unstable/cli` was the moment to write the contract down.

## Decision

### Exit codes: a ladder keyed by who has to act

| code | kind          | meaning                              | examples                                                                            |
| ---- | ------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| 0    | ok            |                                      |                                                                                     |
| 1    | `local`       | fixable without touching the network | bad args, file missing, HTML fails validation, no token stored, malformed state dir |
| 2    | `rejected`    | the instance answered and said no    | 401/403, 404 on an update, share or delete, 409, 413, 429, a server-side 400        |
| 3    | `unreachable` | no usable answer from the instance   | DNS/connect/timeout, 5xx, an unparseable body                                       |
| 130  | interrupted   | SIGINT/SIGTERM → fiber interruption  |                                                                                     |

Nothing else. A defect (a bug, an unmodelled error) is one `Unexpected error:
<message>` line on stderr and exit 1, with the stack only at
`--log-level debug`. HTTP status maps to kind as 4xx → `rejected`, everything
that is not an answer — 5xx, connect, timeout, a body the wire schemas cannot
read — → `unreachable`: "retry later, or tell the operator" is one action.

In code: one `CliError` union (`packages/cli/src/CliError.ts`), each tag
carrying its `kind`, and a single table `exitCode(kind)`. Every command runs
under one wrapper (`Output.contract`) that renders a failure and fails with
its code; no command exits on its own.

### `--json`: a global flag on every command

- Success: stdout is exactly one JSON document. For `whoami`, `upload`, `share` and
  `delete` it is the wire shape from `@patchy/api`; `validate` prints `{ ok, warnings }`,
  `auth set` `{ ok, instanceUrl }`, `status` its report (its only format).
  Upload warnings ride in `warnings: []`, never on stderr. Upload and share report
  `scope`; the field name `publicUrl` alone does not imply anonymous access.
- Failure: stderr is `{ "ok": false, "error": "<the one-line message>", "kind": "local" | "rejected" | "unreachable" }`,
  stdout is empty, the exit code follows `kind`. The same shape as the
  server's 401 body, plus `kind`. No `code` field until an agent flow branches
  on one.
- Stderr under `--json` carries failures only.

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
