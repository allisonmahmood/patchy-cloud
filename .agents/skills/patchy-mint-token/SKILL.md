---
name: patchy-mint-token
description: Mint Patchy Cloud API tokens as the Patchy Cloud operator and wire them into the CLI. Use when the user says "mint a patchy token", "patchy token", "patchy auth is not set up", or "patchy upload is unauthorized".
metadata:
  internal: "true"
---

# Minting Patchy Cloud API Tokens

Use this skill when an agent or a new machine needs an operator-minted token for
Patchy Cloud, or for a `pnpm dev` instance of this repo. Every upload requires an
`upload`-scoped token: a request with no bearer token is rejected with 401, and no
setting relaxes that. When self-service minting is on the CLI mints its own token on
first use, so reach for this skill only when a token must be issued by the operator —
a named per-client credential, or a `pnpm dev` instance where the seeded
`patchy-dev-token` in `.local/dev/env` is not what you want.

This is the operator's skill. It sits outside `skills/`, so it is not part of the
bundle the CLI ships, and it is marked `metadata.internal`. Only the Patchy Cloud
operator holds an admin token; if your user is not the operator, stop.

## How token issuance works

- The deployment has a bootstrap credential: `PATCHY_BOOTSTRAP_API_TOKEN` in the
  server's environment becomes a real API token with `admin` and `upload` scopes when
  the tokens layer builds.
- Any token with the `admin` scope can mint further tokens via `POST /api/tokens`.
- Minted tokens default to the `upload` scope. `admin` satisfies every scope check; grant
  it only to tokens that need to mint other tokens.
- The token value (`pp_...`) appears once, in the mint response. It is not retrievable
  later.

## Step 1 — find an admin token

Look wherever the deployment defines the server's environment — the hosting
platform's secret store, or `.local/dev/env` for a dev instance. Treat whatever you
find as a secret: acquire it through a non-echoing prompt or directly from the secret
store, and never print it into logs, transcripts, or commits.

## Step 2 — mint, save, and verify a scoped token

Requires Node.js 22 or newer, and the `patchy` CLI on `PATH`.

```bash
(
set +x
API="https://pages.example.com" # Patchy Cloud, or the dev instance URL
PATCHY_API_URL=$API
export PATCHY_API_URL
unset PATCHY_API_TOKEN
MINT_TMP_DIR=''
AUTH_HEADER_FILE=''
RESPONSE_FILE=''
MINTED_TOKEN_FILE=''
MINT_PRESERVE=false
ADMIN_TOKEN=''
NEW_TOKEN=''

mint_cleanup() {
  unset ADMIN_TOKEN NEW_TOKEN
  if test -n "$AUTH_HEADER_FILE"; then
    rm -f "$AUTH_HEADER_FILE"
  fi
  if test -n "$MINT_TMP_DIR" &&
     test "$MINT_PRESERVE" != true; then
    rm -rf "$MINT_TMP_DIR"
  fi
}
trap 'mint_cleanup' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Admin token: ' > /dev/tty
if ! IFS= read -r -s ADMIN_TOKEN < /dev/tty; then
  ADMIN_TOKEN=''
  IFS= read -r -s ADMIN_TOKEN ||
    test -n "$ADMIN_TOKEN" || {
      printf '\nCould not read the admin token.\n' > /dev/tty
      exit 1
    }
fi
printf '\n' > /dev/tty
if test -z "$ADMIN_TOKEN"; then
  printf 'The admin token must not be empty.\n' >&2
  exit 1
fi
if ! MINT_TMP_DIR="$(mktemp -d)" || ! chmod 700 "$MINT_TMP_DIR"; then
  printf 'Could not create the token-mint temporary directory.\n' >&2
  exit 1
fi
AUTH_HEADER_FILE="$MINT_TMP_DIR/auth.headers"
RESPONSE_FILE="$MINT_TMP_DIR/response.json"
MINTED_TOKEN_FILE="$MINT_TMP_DIR/minted-upload-token"
if ! (umask 077; printf 'Authorization: Bearer %s\n' \
  "$ADMIN_TOKEN" > "$AUTH_HEADER_FILE") ||
   ! chmod 600 "$AUTH_HEADER_FILE" ||
   ! (umask 077; : > "$RESPONSE_FILE") ||
   ! chmod 600 "$RESPONSE_FILE"; then
  printf 'Could not create protected token-mint files.\n' >&2
  exit 1
fi
unset ADMIN_TOKEN

if ! curl --fail --silent --show-error --request POST \
  --output "$RESPONSE_FILE" \
  --header "@$AUTH_HEADER_FILE" \
  --header "content-type: application/json" \
  --data '{"name":"laptop agent","scopes":["upload"]}' \
  "$API/api/tokens"; then
  printf 'Could not mint the scoped token.\n' >&2
  exit 1
fi
MINT_PRESERVE=true
if ! rm -f "$AUTH_HEADER_FILE"; then
  MINT_PRESERVE=false
  printf 'Could not remove the temporary administrator authorization header.\n' >&2
  exit 1
fi
AUTH_HEADER_FILE=''
if ! (umask 077; set -C; jq -er \
  '.token | select(type == "string" and length > 0)' \
  "$RESPONSE_FILE" > "$MINTED_TOKEN_FILE") ||
   ! chmod 600 "$MINTED_TOKEN_FILE"; then
  printf 'Token extraction failed. Inspect the protected response at %s\n' \
    "$RESPONSE_FILE" >&2
  exit 1
fi

NEW_TOKEN=''
IFS= read -r NEW_TOKEN < "$MINTED_TOKEN_FILE" ||
  test -n "$NEW_TOKEN" || {
    printf 'Credential handoff failed. Recover the minted token from %s\n' \
      "$MINTED_TOKEN_FILE" >&2
    exit 1
  }
if test -z "$NEW_TOKEN"; then
  printf 'Credential handoff failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit 1
fi
if printf '%s' "$NEW_TOKEN" | patchy auth set --token-stdin --api-url "$API"; then
  unset NEW_TOKEN
else
  auth_status=$?
  unset NEW_TOKEN
  printf 'Credential save failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit "$auth_status"
fi
if ! patchy whoami; then
  printf 'Credential verification failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit 1
fi
MINT_PRESERVE=false
)
```

## Step 3 — retain only the saved credential

The scoped token is minted, captured, and consumed inside one `set +x` subshell, so an
inherited xtrace setting cannot print the admin token, mint response, extracted token, or
stdin handoff. The explicit stdin path keeps the token out of process arguments. Once the
server returns a token, extraction, save, or verification failure retains the protected
response or token and prints only its recovery path. Full success removes every temporary
secret.

Name tokens after the machine or agent that will hold them — one token per client keeps
revocation painless.

`whoami` calls `GET /api/me` and prints the account, token name, and scopes. Credentials
land in `~/.patchy/credentials.json`; every save creates or repairs that file to
owner-only permissions on Unix. Always pass `--api-url`: the CLI's built-in fallback is a
server on this machine, never Patchy Cloud.

## Resolving a complaint: from a page to the token behind it

Four admin-scoped endpoints close the loop; the database is never edited by hand.

Put the admin credential in a protected header file first, exactly as Step 2 does, so it
never reaches a process argument list or the shell history:

```bash
API=https://pages.example.com
MODERATION_HEADER_FILE="$(mktemp)"
chmod 600 "$MODERATION_HEADER_FILE"
(set +x; umask 077; printf 'authorization: Bearer %s\n' "$ADMIN_TOKEN" \
  > "$MODERATION_HEADER_FILE")
unset ADMIN_TOKEN
```

Then walk the loop, substituting the IDs each step hands you:

```bash
# 1. The flagged URL's patch ID -> the principal and the token that created it.
curl --fail --silent --show-error --header "@$MODERATION_HEADER_FILE" \
  "$API/api/patches/PATCH_ID"

# 2. Everything else that principal is holding, newest first, up to 200 at a time.
#    Deleted patches are omitted; disabled ones are not. `truncated: true` means
#    there are more: DELETING patches is what reveals them, because deleting is what
#    takes them off this list. Disabling a page leaves it here.
curl --fail --silent --show-error --header "@$MODERATION_HEADER_FILE" \
  "$API/api/principals/PRINCIPAL_ID/patches"

# 3. Take individual pages down: disable hides one, delete removes it.
curl --fail --silent --show-error --request POST \
  --header "@$MODERATION_HEADER_FILE" --header "content-type: application/json" \
  --data '{"reason":"operator decision"}' "$API/api/patches/PATCH_ID/disable"
curl --fail --silent --show-error --request DELETE \
  --header "@$MODERATION_HEADER_FILE" "$API/api/patches/PATCH_ID"

# 4. Revoke the token itself, then discard the header file.
curl --fail --silent --show-error --request POST \
  --header "@$MODERATION_HEADER_FILE" "$API/api/tokens/API_TOKEN_ID/revoke"
rm -f "$MODERATION_HEADER_FILE"
```

## Revoking tokens

`POST /api/tokens/<apiTokenId>/revoke` sets the token's revoked-at state. Every request
reads the database, so it takes effect immediately: from that moment the token
authenticates nothing, and the caller sees the same 401 any bad credential gets.

Revoked is a **state, never a deletion**. The row survives with its mint provenance for
later review, and the endpoint never removes it — `patch_versions` references the token, so
Postgres would reject the delete for anything that has ever uploaded anyway.

Revoking is idempotent: a second call returns `alreadyRevoked: true` and the _original_
`revokedAt`, because that moment is when the token's patches stopped receiving visit
top-ups. Their clocks only run down from there — the pages stay up until expiry takes
them, and no visit extends them again. There is no un-revoke; a replacement credential
is a fresh mint.

An unknown token ID answers 404. Revocation does not touch the token's patches: disable
or delete those individually if they should come down before their clocks run out.

Two cases where revoking alone will not age a page out:

- **A pinned patch is exempt from expiry.** If step 1's read shows `pinnedAt`, the clock
  will never take that page however long you wait — unpin, disable, or delete it yourself.
- **Revocation is scoped to the token, not the principal.** Where you have minted several
  tokens on one principal, a surviving sibling can still update that principal's patches and
  reset their 90-day window. Revoke every token on the principal, or delete the patches. A
  self-service token is 1:1 with its principal, so this only bites operator-created tokens.

Revoking works the same way whichever way the token was created: an operator mint from
`POST /api/tokens` and a self-service mint both answer to this endpoint by token ID, and
neither loses its mint record.

## Pitfalls

- Do the whole mint in one compound shell command so tokens stay in variables; `set -x`,
  echoed commands, and pasted API responses all leak them.
- The mint response is the only time the token value is visible. Capture `.token`, or mint
  a fresh one.
- Never pass a token positionally to `patchy auth set`; use the hidden prompt for a
  person or explicit `--token-stdin` for automation.
- Tokens gate publishing, ownership, and updates. Patch URLs stay public and unlisted
  regardless; a token does not make a patch private. An `upload` token disables or deletes
  only the patches it owns; an `admin` scope moderates any principal's patch, which is how
  the operator takes down a flagged page.
- Do not hand the bootstrap token to CLI clients; mint per-client `upload` tokens instead.
