# @patchy/cli

Command-line uploader for [Patchy Cloud](https://github.com/allisonmahmood/patchy-cloud). It sends static HTML patches to a Patchy Cloud instance, changes their sharing and takes them down again. Every upload carries a machine token; new patches are company-scoped by default and open through a colleague's signed-in browser. Choose public explicitly to let anyone with the link open a patch. A machine token never opens a patch's view URL.

An agent is the primary driver, so the CLI promises a contract an agent can branch on without reading prose: an [exit code that says who has to act](#exit-codes), `--json` on every command, and one resolution of which instance is being targeted. The contract is [ADR-0004](../../docs/adr/ADR-0004-cli-contract-for-agents.md).

The CLI talks to whichever instance you point it at — Patchy Cloud, or the `pnpm dev` instance of a checkout — and falls back to `http://localhost:3000`, a server running from this repo on your own machine.

## Run it

Requires Node.js 22 or newer. The package is private and not published, so run it from a checkout of this repo:

```sh
pnpm --filter @patchy/cli build
node packages/cli/dist/index.js login --api-url https://pages.example.com
```

The build puts an executable at `packages/cli/dist/index.js`. Put that file on your `PATH` as `patchy` — symlink it, or add its directory — and every command below runs as plain `patchy`, which is how the rest of this document writes them.

First run is `patchy login`, then `patchy upload ./plan.html`. A person at a real
terminal confirms in their browser while login waits. An agent receives a URL,
code and next command, relays them to the person, and runs that next command
after the handoff; it never opens a browser. Uploading the same file again
updates the same patch. Inside a `pnpm dev` worktree, the seeded key works
without a login, and a saved login takes precedence over that seed.

## Commands

### `patchy login [--complete [code]] [--wait <seconds>]`

Log this machine in to the resolved instance. Start sends this machine's
hostname as the name hint, plus the stored key's id on re-login. A rerun with
a live login pending resumes it rather than creating another code.
`--api-url <url>` also saves the instance choice. The returned `next` retains
that flag, since a worktree's dev env or `PATCHY_API_URL` outranks saved config.
Keep the flag on later uploads when overriding those sources.

```sh
patchy login --api-url https://pages.example.com --json
# Relay verificationUrl and userCode to the person, then run the returned next:
patchy login --complete XXXX-XXXX --api-url 'https://pages.example.com'
# Logged in to https://pages.example.com as Acme. This machine is "Work laptop".
patchy upload ./plan.html --api-url https://pages.example.com
```

Use the returned code, not the placeholder. The person opens the URL in their
own browser, signs in with Google, Microsoft or an emailed code if needed,
checks the code, company and email, names the machine, and confirms. The
publishing key is saved locally and never printed. It works for 90 days or
30 idle days, whichever comes first; revoke it on **Your machines**.
Re-login for the same user inherits the old key's name and replaces that key
when the terminal completes, without changing ownership of any patches.

Login blocks only when stdin is a terminal, `--json` is absent, and none of
`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CURSOR_AGENT`, `CODEX_SANDBOX`,
`CODEX_SANDBOX_NETWORK_DISABLED`, `GEMINI_CLI`, `OPENCODE`, `CLINE_ACTIVE`,
`AI_AGENT` or `CI` is set. That human path prints the handoff and waits until
the person answers or the code expires. Otherwise it prints the handoff and
why it did not wait, then exits 0. An agent relays both the URL and code,
never opens a browser, and follows `next`.

`--complete` uses the pending login; an optional code must match it or the
command exits 1 (`local`), naming the live code. Polling follows the returned
interval, adding five seconds on `slow_down`. `--wait` bounds completion
polling (default 60 seconds); `--wait 0` polls once. Still pending is exit 0
and can be resumed with the same `next`. Denied, expired and unknown are
instance answers, exit 2 (`rejected`); the CLI polls even if the local expiry
has passed. Completion saves the key and machine and clears the pending login.

Under `--json`, exactly one success document is written:

| result        | document                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handoff       | `{ ok, status: "awaiting_confirmation", verificationUrl, verificationUrlBare, userCode, expiresAt, interval, next, agentNextSteps, notWaitingBecause }` |
| Still waiting | `{ ok, status: "pending", userCode, expiresAt, next, agentNextSteps }`                                                                                  |
| Complete      | `{ ok, status: "logged_in", instanceUrl, company: { handle, name }, user: { email }, machine: { id, name }, credentialsPath }`                          |

`next` is `patchy login --complete <userCode>`, retaining a shell-quoted
`--api-url` when the instance was selected by flag. `agentNextSteps` tells the
agent to show the person the URL and code, leave the browser to them, and run `next`.
Neither the publishing key nor the private device code is in these documents.

### `patchy logout`

Forget the resolved instance's stored credential and pending login first,
then revoke only the key just deleted through `POST /api/logout`. A 401 means
it is already invalid and counts as success. An unreachable instance cannot
undo the local logout: exit 0, with this warning:

> Logged out on this machine. The key could not be revoked; it expires on its own after 30 idle days, or revoke it now on Your machines.

Logout removes only local stored credentials. Inside a worktree it says
_This worktree's dev instance still publishes with its seeded key_;
`whoami` then names the seeded machine again. With `PATCHY_API_TOKEN` set it
warns that the publishing key from the environment is not its to remove. Neither
that key nor the seed is sent for courtesy revocation. Logout does not sign
the browser out; use **Sign out** on **Your machines** for that.

`--json` prints `{ ok, instanceUrl, revoked, warnings }`. `revoked` is true
when the deleted key was revoked or already invalid; it is false if no
stored key existed or revocation could not be completed. Warnings are in
the document, never on stderr.

### `patchy auth set [--token-stdin] [--api-url <url>]`

Save a machine token you already hold (`source: "auth-set"`), rather than starting a login. The [instance resolution order](#environment-variables) applies, including the dev env. Saving a key for one instance leaves other instances untouched. By default, `auth set` requires a terminal and reads the key from a non-echoing prompt. Pass `--api-url` to also save that base URL. Ordinary first-run publishing uses `patchy login`; this command remains for existing keys, including the dev seed and packed automation.

```sh
patchy auth set --api-url https://pages.example.com
```

For automation that already has a key, the packed workflow saves it through
stdin without putting the token in an argument or output:

<!-- patchy-packed-cli-e2e:start -->

```sh
set +x
: "${PATCHY_SETUP_URL:?Set PATCHY_SETUP_URL to your Patchy Cloud instance}"
: "${PATCHY_SETUP_TOKEN:?Set PATCHY_SETUP_TOKEN to a machine token you already hold}"
printf '%s' "$PATCHY_SETUP_TOKEN" | patchy auth set --token-stdin --api-url "$PATCHY_SETUP_URL"
```

<!-- patchy-packed-cli-e2e:end -->

### `patchy whoami [--api-url <url>]`

Verify the configured credentials against the instance. Prints the user, company, role and machine.

```sh
patchy whoami
# User: Patchy Dev (dev@patchy.local)
# Company: Patchy Dev (patchy-dev)
# Role: admin
# Machine: Dev Machine (tok_dev)
```

`--json` returns `Identity` directly, with no `ok` wrapper:
`{ user: { id, email, name }, company: { id, handle, name }, role, machine: { id, name } }`.
The machine id is its token id. With no key, this command exits 1 (`local`),
`Run: patchy login`; a rejected key is exit 2.

### `patchy status [--api-url <url>]`

Report what the publishing state looks like on this machine for the resolved instance. It is strictly local — it never contacts the instance it names — and it exits `0` whether or not anything is configured, so it answers rather than checks. JSON is its only output format, with or without `--json`.

```sh
patchy status
# {
#   "instanceUrl": "https://pages.example.com",
#   "instanceSource": "config",
#   "hasToken": true,
#   "tokenSource": "login",
#   "stateDir": "/home/you/.patchy",
#   "hasDefaultStyle": false,
#   "cliVersion": "0.0.1"
# }
```

`instanceSource` names what selected the URL: `flag`, `dev-env`, `env`, `config`, or `default`. `hasToken` walks the same credential chain as every authenticated command: `PATCHY_API_TOKEN`, stored credential for this instance, then the dev seed. `tokenSource` is `login` or `auth-set` for the selected saved key, or `null` for an environment/dev-env key, an older entry without provenance, or no usable key. The token itself is never printed.

Local state the probe cannot read — a file in the retired single-instance format, malformed JSON, an unreadable file, or an invalid entry for this instance — is reported as `hasToken: false` rather than raised as an error, because a probe that cannot answer is worse than one that answers narrowly. The commands that would actually spend a token keep failing closed on exactly those files: `upload`, `share`, `delete` and `whoami` stop with an error naming the file and its next action, and never treat it as a reason to publish without credentials.

So this report is a picture of local state, not a prediction of what `upload` will do. `hasToken: false` does not promise the next upload proceeds without a token, and it never means this machine has no token — a token may be sitting in a file the probe refused to guess about.

### `patchy validate <file>`

Validate an HTML file locally without uploading. Exits non-zero if validation fails; prints warnings otherwise.

```sh
patchy validate ./plan.html
```

### `patchy upload <file> [--share company|public] [--patch <patch-id>] [--new] [--api-url <url>]`

Validate the file, then upload it. On success it prints the view URL, the patch ID, the version number and the sharing scope with who can open the link, after a line naming the instance and where that choice came from. The JSON response includes `scope: "company" | "public"`. Its URL field remains `publicUrl`; the scope, not that field name, controls who may read it.

```sh
patchy upload ./plan.html
# Publishing to https://pages.example.com (target came from the saved config).
# Uploaded patch
# URL: https://pages.example.com/d/k7f2m9x1a3b8
# Scope: company (signed-in colleagues in your company)
# Patch ID: k7f2m9x1a3b8
# Version: 1
```

Credential selection is deterministic: `PATCHY_API_TOKEN` wins, then the token stored for the resolved instance, then the token seeded beside a dev-env URL. A login therefore outranks the seed. With no key, upload exits 1 (`local`), `Run: patchy login`. A rejected credential is reported as-is; the CLI never starts a login or obtains a replacement on your behalf.

Uploading a previously seen file updates the same patch. If it is unavailable, the upload fails; pass `--new` to create a new patch with a server-generated ID. `--patch <patch-id>` is update-only for an active patch owned by your user, through any of that user's machine tokens. Unknown, unavailable and unowned targets fail with the same generic error.

Without `--share`, a new patch defaults to `company` and an update preserves the patch's current scope. An explicit `--share company` or `--share public` sets it in either direction while publishing the new version:

```sh
patchy upload ./plan.html --share public --json
patchy upload ./plan.html                 # updates content, stays public
patchy upload ./plan.html --share company # updates content, takes it back inside
```

### `patchy share <file> <company|public>` or `patchy share --patch <patch-id> <company|public>`

Change an existing patch's sharing without uploading a version. Name the file it was uploaded from to use the CLI's per-instance cache, or pass `--patch <patch-id>`; one or the other, not both. Only the owner user can change sharing, through any of their machine tokens. Company membership or an admin role alone does not grant that right.

```sh
patchy share ./plan.html public
# Changed patch sharing
# URL: https://pages.example.com/d/k7f2m9x1a3b8
# Scope: public (anyone with the link)
# Patch ID: k7f2m9x1a3b8

patchy share --patch k7f2m9x1a3b8 company --json
# {"ok":true,"patchId":"k7f2m9x1a3b8","scope":"company","publicUrl":"https://pages.example.com/d/k7f2m9x1a3b8"}
```

Share uses the same credential chain as upload. With no key it exits 1 (`local`), `Run: patchy login`; a missing cached file target is also `local`. An unavailable or unowned patch answers 404 (`rejected`, exit 2), including under `--json`.

Read company patches through the user's signed-in browser; only public patches fetch directly by URL. Public responses have `Cache-Control: public, max-age=60` at both the latest and `/v/<n>` URL shapes. After changing to company, origin responses are `private, no-store` and a cookie-free fetch answers 401. A previously cached public copy may remain reachable for up to 60 seconds; already downloaded copies cannot be recalled.

### `patchy delete <file> | --patch <patch-id>`

Delete a patch. Irreversible: the page stops serving at once, so confirm with the user first. Name the file the patch was uploaded from and the CLI finds the patch in its cache, or pass `--patch <patch-id>` to name it outright; one or the other, not both. On success the cache forgets the patch, so a later upload from that file creates a new one.

```sh
patchy delete ./plan.html
# Deleting from https://pages.example.com (target came from the saved config).
# Deleted patch
# Patch ID: k7f2m9x1a3b8
```

Delete uses the same credential chain as upload. Any machine token for the owner user can delete the patch. With no key it exits 1 (`local`), `Run: patchy login`; a missing or unowned patch is `rejected`, and the cache keeps its entry until the instance says yes.

## Exit codes

The code says who has to act, so an agent can branch on it without reading the message:

| code | kind          | meaning                              | examples                                                                                          |
| ---- | ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 0    | ok            | the command's act succeeded          | login handoff or still pending; logout even if courtesy revocation fails                          |
| 1    | `local`       | fixable without touching the network | bad args, file missing, HTML fails validation, no key, a foreign login code, malformed state dir  |
| 2    | `rejected`    | the instance answered and said no    | rejected key, missing update/share/delete target, quota, rate limit, denied/expired/unknown login |
| 3    | `unreachable` | no usable answer from the instance   | DNS/connect/timeout, a 5xx, a body the CLI could not read                                         |
| 130  | interrupted   | SIGINT or SIGTERM                    |                                                                                                   |

Nothing else. A bug in the CLI is one `Unexpected error: <message>` line and exit 1; add `--log-level debug` for the stack.

Examples of login's terminal refusals (all exit 2):

- `The login was denied in the browser. Nothing was saved. Run: patchy login`
- `The login expired before it was confirmed (codes last ten minutes). Run: patchy login`
- `No login is pending for code XXXX-XXXX on <instance>; it may already have been reported. Run: patchy login`

`patchy login --complete --wait 0` answering `pending` is exit 0.
After logout outside a worktree, with no environment key, `patchy whoami`
is exit 1 with `Run: patchy login`. A failed courtesy revocation is only a
warning after the local logout succeeds, never exit 3.

## Global flags

Every command takes these, before or after the subcommand:

- `--api-url <url>` — the instance to talk to, overriding every other source; see [precedence](#environment-variables).
- `--json` — one result document on stdout. Login's three shapes and logout's shape are documented above; `auth set` prints `{ "ok": true, "instanceUrl" }`, `validate` prints `{ "ok": true, "warnings" }`, and `whoami`, `upload`, `share` and `delete` print the instance's response exactly as [`docs/API.md`](../../docs/API.md) describes it. Upload and share include `scope`. A failure is `{ "ok": false, "error", "kind" }` on stderr, stdout empty, with the exit code for `kind`. Stderr is otherwise empty; warnings belong in success documents. `status` prints JSON either way.

## Command flags

- `--complete [code]` — on `login`, finish the pending device login; an optional code must match the saved one.
- `--wait <seconds>` — on `login --complete`, poll for up to this long (default 60); zero polls once and returns immediately if still pending.
- `--token-stdin` — on `auth set`, read exactly one non-empty token from redirected stdin. This is the explicit automation path and is rejected when stdin is a terminal.
- `--share company|public` — on `upload`, explicitly set who may read the patch. Without it, creates default to company and updates preserve scope.
- `--new` — on `upload`, always create a new patch with a server-generated ID instead of updating the one previously uploaded from this path. It cannot be combined with `--patch`.
- `--patch <patch-id>` — on `upload`, update a specific existing patch. This is update-only and never creates a new patch. It cannot be combined with `--new`.
- `--patch <patch-id>` — on `share` and `delete`, name the patch outright instead of finding it from the file it was uploaded from. It cannot be combined with a file argument.

## Environment variables

- `PATCHY_API_URL` — API base URL. Overrides the stored config; overridden by `--api-url` and by a dev env. Default: `http://localhost:3000`.
- `PATCHY_API_TOKEN` — machine token for authenticated commands such as `whoami`, `upload`, `share` and `delete`. It overrides every other token; `auth set` does not read it, and `logout` does not remove or revoke it. No configured key means a local error naming `patchy login`.
- `PATCHY_STATE_DIR` — directory for the CLI's config, credentials, pending logins, patch cache and default style. Default: `~/.patchy`.

Setting any of these to the empty string means the same thing as leaving it unset.

The instance is resolved once per command, in this order: `--api-url`, then the `.local/dev/env` that `pnpm dev` writes in a worktree (searched upward from the working directory, with the token it seeded), then `PATCHY_API_URL`, then the saved `config.json`, then the default. A checkout with a running dev instance therefore publishes to it without any environment set, and can never publish to a remote instance by accident.

## State

The CLI stores state under `~/.patchy` (or `PATCHY_STATE_DIR`):

- `config.json` — the saved API base URL.
- `credentials.json` — saved machine tokens, keyed by instance, with `source: "login"` or `"auth-set"`. A login entry also carries `machine: { id, name }`. On Unix, every save creates or repairs this file to owner-only (`0600`) permissions.
- `device-login.json` — one pending login per instance: private device code, user code, both verification URLs, polling interval and expiry. Owner-only (`0600`); cleared for that instance on completion or logout.
- `patches.json` — the patch cache, keyed by instance and then by absolute file path, so later uploads from the same path update the same patch and `share` or `delete` can find it from the path. A successful `delete` drops every entry that pointed at the patch.
- `style.md` — the default style, owned and written by the agent skill. The CLI never reads its contents; `status` reports only whether it exists.

Credentials, pending logins and the patch cache are keyed by the resolved API base URL under exact string equality, so instances that differ only by scheme, host, or port are separate entries by design:

```jsonc
// credentials.json
{ "hosts": { "https://pages.example.com": { "token": "…", "updatedAt": "…", "source": "login", "machine": { "id": "tok_…", "name": "Work laptop" } } } }
// device-login.json
{ "hosts": { "https://pages.example.com": { "deviceCode": "…", "userCode": "XXXX-XXXX", "verificationUrl": "https://pages.example.com/login/device?code=XXXX-XXXX", "verificationUrlBare": "https://pages.example.com/login/device", "interval": 5, "expiresAt": "…" } } }
// patches.json
{ "hosts": { "https://pages.example.com": { "files": { "/abs/plan.html": { "patchId": "…", "publicUrl": "…", "latestVersionNumber": 3, "updatedAt": "…" } } } } }
```

A token saved for one instance is never sent to another, and a patch ID cached for one instance is never replayed against another. Files written by an older CLI in the previous single-instance format are not migrated: the CLI stops with an error naming the file, so a token that still controls live patches is never discarded silently. Copy anything you need out of the old file, then delete it. A patch cache still named `drafts.json`, from before _patch_ replaced _draft_, is refused the same way: rename it to `patches.json` to keep updating the patches it remembers, or delete it.

## Agent skill

This package bundles an agent skill at `skills/patchy/SKILL.md` that teaches an assistant to produce safe static HTML pages in the Patchy visual style and publish them with this CLI.

## Security

Report vulnerabilities privately by following the [security policy](https://github.com/allisonmahmood/patchy-cloud/blob/main/SECURITY.md).

## License

All rights reserved for now. See [LICENSE](https://github.com/allisonmahmood/patchy-cloud/blob/main/LICENSE).
