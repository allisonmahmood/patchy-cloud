# @patchy/cli

Command-line uploader for [Patchy Cloud](https://github.com/allisonmahmood/patchy-cloud). It sends static HTML drafts to a Patchy Cloud instance, which serves them behind unlisted, link-viewable URLs. Every upload carries a bearer API token; draft viewer URLs are public and unlisted, so anyone with the link can view the rendered page.

There is no hosted instance to default to: the CLI talks to whichever instance you point it at, and falls back to `http://localhost:3000` — a server running from this repo on your own machine. See the [self-hosting guide](https://github.com/allisonmahmood/patchy-cloud/blob/main/docs/SELF_HOSTING.md) to run one somewhere else.

## Run it

Requires Node.js 22 or newer. The package is private and not published, so run it from a checkout of this repo:

```sh
pnpm --filter @patchy/cli build
node packages/cli/dist/index.js upload ./plan.html
```

The build puts an executable at `packages/cli/dist/index.js`. Put that file on your `PATH` as `patchy` — symlink it, or add its directory — and every command below runs as plain `patchy`, which is how the rest of this document writes them.

A publishing key is minted on first upload against an instance that hands them out, the URL prints on success, and uploading the same file again updates the same draft.

For CI and other automation, set `PATCHY_SETUP_URL` to the instance you are publishing to and provide `PATCHY_SETUP_TOKEN` through a secret environment variable. This scoped workflow pins the intended instance, clears inherited credential overrides, verifies the stored token, and exits before upload if authentication or validation fails:

<!-- patchy-packed-cli-e2e:start -->

```sh
(
  set +x
  set -eu
  : "${PATCHY_SETUP_URL:?Set PATCHY_SETUP_URL to your Patchy Cloud instance}"
  : "${PATCHY_SETUP_TOKEN:?Set PATCHY_SETUP_TOKEN to a Patchy Cloud API token}"
  PATCHY_API_URL="$PATCHY_SETUP_URL"
  export PATCHY_API_URL
  unset PATCHY_SETUP_URL
  unset PATCHY_API_TOKEN
  unset TOKEN
  ARTIFACT_PATH='./review artifact.html'

  printf '%s' "$PATCHY_SETUP_TOKEN" | patchy auth set --token-stdin --api-url "$PATCHY_API_URL"
  unset PATCHY_SETUP_TOKEN
  patchy whoami &&
    patchy validate "$ARTIFACT_PATH" &&
    patchy upload "$ARTIFACT_PATH"
)
```

<!-- patchy-packed-cli-e2e:end -->

## Commands

### `patchy auth set [--token-stdin] [--api-url <url>]`

Save an API token to local state, under the instance it resolves for: `--api-url`, else `PATCHY_API_URL`, else the stored config, else the default. Saving a token for one instance leaves tokens saved for other instances untouched. By default, `auth set` requires a terminal and reads the token from a non-echoing prompt. Pass `--api-url` to also store that base URL, so later commands don't need the flag.

```sh
patchy auth set --api-url https://pages.example.com
```

For automation, use the fail-closed workflow above. It clears inherited URL and token overrides, stores the setup token through stdin, and verifies the stored credential before validation or upload.

### `patchy whoami [--api-url <url>]`

Verify the stored credentials against the instance. Prints the account, the token name, and the token's scopes.

```sh
patchy whoami
# Account: Bootstrap Account (acct_bootstrap)
# API token: laptop (tok_1a2b3c...)
# Scopes: upload
```

### `patchy status --json [--api-url <url>]`

Report what the publishing state looks like on this machine for the resolved instance. It is strictly local — it never contacts the instance it names — and it exits `0` whether or not anything is configured, so it answers rather than checks. JSON is its only output format.

```sh
patchy status --json
# {
#   "instanceUrl": "https://pages.example.com",
#   "instanceSource": "config",
#   "hasToken": true,
#   "tokenSource": "auth-set",
#   "stateDir": "/home/you/.patchy",
#   "hasDefaultStyle": false,
#   "cliVersion": "0.0.1"
# }
```

`instanceSource` names the link of the precedence chain that chose `instanceUrl`: `flag` (`--api-url`), `env` (`PATCHY_API_URL`), `config` (the saved `config.json`), or `default`. `hasToken` walks the same credential chain an upload would, so `true` means an upload would have that token to send. Read `false` as _no token this command can vouch for_ — usually nothing is stored, but it also covers local state the probe declined to interpret. `tokenSource` is the stored credential's own `source` (`mint` or `auth-set`); it is `null` when there is no token, when the token came from `PATCHY_API_TOKEN`, or when the stored entry predates that field. The token itself is never printed.

Local state the probe cannot read — a file in the retired single-instance format, malformed JSON, an unreadable file, or an invalid entry for this instance — is reported as `hasToken: false` rather than raised as an error, because a probe that cannot answer is worse than one that answers narrowly. The commands that would actually spend a token keep failing closed on exactly those files: `upload` and `whoami` stop with an error naming the file and its next action, and never treat it as a reason to publish without credentials.

So this report is a picture of local state, not a prediction of what `upload` will do. `hasToken: false` does not promise the next upload proceeds without a token, and it never means this machine has no token — a token may be sitting in a file the probe refused to guess about.

### `patchy validate <file>`

Validate an HTML file locally without uploading. Exits non-zero if validation fails; prints warnings otherwise.

```sh
patchy validate ./plan.html
```

### `patchy upload <file> [--draft <draft-id>] [--new] [--api-url <url>]`

Validate the file, then upload it. On success it prints the public URL, the draft ID, and the version number.

```sh
patchy upload ./plan.html
# Uploaded draft
# URL: https://pages.example.com/d/k7f2m9x1a3b8
# Draft ID: k7f2m9x1a3b8
# Version: 1
```

Credential selection is deterministic: `PATCHY_API_TOKEN` wins over the token stored for the resolved instance. When neither exists, the CLI mints a publishing token for that instance and uses it. Every upload carries a bearer token; no configuration accepts a credential-free upload, and an authentication failure is reported as-is rather than retried without credentials.

With credentials, uploading a file the CLI has seen before updates that same draft (a new version). If that cached draft is unavailable, the upload fails; pass `--new` to create a brand-new draft with a server-generated ID. `--draft <draft-id>` is update-only: it can add a version to an existing active draft your own token owns, but it never creates a draft at a caller-chosen ID. Unknown, unavailable, or unowned targets fail with the same generic update error.

## Flags

- `--api-url <url>` — override the API base URL for this command (available on `auth set`, `whoami`, `status`, and `upload`).
- `--json` — on every command, print the result as one JSON document on stdout: `auth set` prints `{ "ok": true, "instanceUrl" }`, `validate` prints `{ "ok": true, "warnings" }`, and `whoami` and `upload` print the instance's response exactly as [`docs/API.md`](../../docs/API.md) describes it. A failure is `{ "ok": false, "error" }` on stderr with exit code 1. On `status` it is required, because JSON is the only format `status` offers.
- `--token-stdin` — on `auth set`, read exactly one non-empty token from redirected stdin. This is the explicit automation path and is rejected when stdin is a terminal.
- `--new` — on `upload`, always create a new draft with a server-generated ID instead of updating the one previously uploaded from this path. It cannot be combined with `--draft`.
- `--draft <draft-id>` — on `upload`, update a specific existing draft. This is update-only and never creates a new draft. It cannot be combined with `--new`.
- `--anonymous` — deprecated and ignored. Uploads always use a publishing token; one is minted automatically when none is stored for the instance.

## Environment variables

- `PATCHY_API_URL` — API base URL. Overrides the stored config; overridden by `--api-url`. Default: `http://localhost:3000`.
- `PATCHY_API_TOKEN` — API token for ordinary authenticated commands such as `whoami` and `upload`. It overrides the token stored for the resolved instance and is useful in CI; `auth set` does not read it. When neither it nor a stored token exists, `upload` mints a publishing token for the resolved instance and uses that; there is no credential-free upload.
- `PATCHY_STATE_DIR` — directory for the CLI's config, credentials, and draft cache. Default: `~/.patchy`.

Setting any of these to the empty string means the same thing as leaving it unset.

## State

The CLI stores state under `~/.patchy` (or `PATCHY_STATE_DIR`):

- `config.json` — the saved API base URL.
- `credentials.json` — saved API tokens, keyed by instance. On Unix, every save creates or repairs this file to owner-only (`0600`) permissions.
- `drafts.json` — the draft cache, keyed by instance and then by absolute file path, so later uploads from the same path update the same draft.
- `style.md` — the default style, owned and written by the agent skill. The CLI never reads its contents; `status` reports only whether it exists.

Both files are keyed by the resolved API base URL under exact string equality, so instances that differ only by scheme, host, or port are separate entries by design:

```jsonc
// credentials.json
{ "hosts": { "https://pages.example.com": { "token": "…", "updatedAt": "…", "source": "auth-set" } } }
// drafts.json
{ "hosts": { "https://pages.example.com": { "files": { "/abs/plan.html": { "patchId": "…", "publicUrl": "…", "latestVersionNumber": 3, "updatedAt": "…" } } } } }
```

A token saved for one instance is never sent to another, and a draft ID cached for one instance is never replayed against another. Files written by an older CLI in the previous single-instance format are not migrated: the CLI stops with an error naming the file, so a token that still controls live drafts is never discarded silently. Copy anything you need out of the old file, then delete it.

## Agent skill

This package bundles an agent skill at `skills/patchy/SKILL.md` that teaches an assistant to produce safe static HTML pages in the Patchy visual style and publish them with this CLI.

## Security

Report vulnerabilities privately by following the [security policy](https://github.com/allisonmahmood/patchy-cloud/blob/main/SECURITY.md).

## License

All rights reserved for now. See [LICENSE](https://github.com/allisonmahmood/patchy-cloud/blob/main/LICENSE).
