# Running a Patchy Cloud instance

The Patchy Cloud server is a normal Node HTTP service and runs anywhere that supports Node or containers. This guide covers running it from source: configuration, the database, starting the server, minting tokens, and pointing the CLI at it.

Once your server is running, point the CLI at it and you have your own instance. Every route and wire shape is listed in [`API.md`](./API.md), rendered from the schemas the server and CLI share. Every upload requires a bearer API token, on every configuration: a request with no `Authorization` header is rejected with 401, and a present but invalid credential stays a 401 rather than being downgraded to a credential-free upload. No server setting relaxes that. Draft viewer URLs are public and unlisted, so anyone with the link can view them.

## Prerequisites

- Node.js 22.13 or newer (the CLI and server require Node 22+, and pnpm 11 needs at least 22.13).
- pnpm (the repo pins `pnpm@11.5.2` via `packageManager`).
- OpenSSL when using the example command to generate a bootstrap credential.
- Docker or another OCI-compatible runtime, only if you build and run the image from this checkout.
- A PostgreSQL database, if you use the `postgres` metadata driver. The default `json` driver needs no database and is fine for small or single-user instances.
- Git is optional; the CLI records repo/branch metadata with each upload when the file is inside a git repo.

## Clone, install, build

```sh
git clone https://github.com/allisonmahmood/patchy-cloud.git
cd patchy-cloud
pnpm install
pnpm build
```

## Configuration

The server reads configuration from process environment variables. It does **not** auto-load a `.env` file, so export these in your shell, container, or process manager. The block below documents every variable the server understands; use it as a reference for what to set.

```env
# HTTP
PORT=3000
PATCHY_PUBLIC_BASE_URL=https://post.example.com
# Leave unset for a direct deployment. Configure only after verifying the proxy path.
# PATCHY_TRUST_PROXY=192.0.2.10,2001:db8:1234::/48

# Auth
# The bootstrap token becomes a usable admin+upload API token on startup/migration.
# Supply it through your secret manager; do not write the value in shell history.
# PATCHY_BOOTSTRAP_API_TOKEN=
# Strict opt-in: only true lets a caller mint its own publishing token.
# Every upload still requires a bearer token regardless of this setting.
PATCHY_ALLOW_SELF_SERVICE_TOKENS=false

# Upload limits
PATCHY_MAX_HTML_BYTES=524288

# Abuse protection
PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE=60
PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE=20
PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE=5
PATCHY_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE=10

# Per-token quotas
PATCHY_LIVE_DRAFTS_PER_TOKEN=1000

# Per-address quotas (only used when self-service minting is on)
PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY=5

# Server-side analytics. Unset means off: no key, no capture, no client.
PATCHY_POSTHOG_API_KEY=
# Defaults to https://us.i.posthog.com. Only read when a key is set.
PATCHY_POSTHOG_HOST=https://us.i.posthog.com

# Metadata store: "postgres" or "json"
# Defaults to "postgres" if DATABASE_URL is set, otherwise "json".
PATCHY_DB_DRIVER=postgres
DATABASE_URL=postgres://user:password@host:5432/patchy
# Only used by the "json" driver.
# Source default: .local/patchy-db.json
# Image default (when you build the image from this repo): /data/patchy-db.json
PATCHY_DB_FILE=.local/patchy-db.json

# HTML object storage: "filesystem" or "azure-blob"
# Defaults to "filesystem".
PATCHY_STORAGE_DRIVER=filesystem
# Source default: .local/drafts
# Image default (when you build the image from this repo): /data/drafts
PATCHY_STORAGE_DIR=.local/drafts

# Only used by the "azure-blob" storage driver:
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=
# If a connection string is absent, azure-blob uses managed identity.
AZURE_STORAGE_CONNECTION_STRING=
```

Notes on values:

- `PATCHY_PUBLIC_BASE_URL` is used to build the public draft URLs returned by uploads and rendered in the viewer. Set it to the externally reachable origin (scheme + host, no trailing slash). It defaults to `http://localhost:3000` for local development.
- `PATCHY_TRUST_PROXY` controls whether Fastify derives `request.ip` from `X-Forwarded-For`. Leave it undefined unless every route to the server has a verified trust boundary. See [Client IP attribution behind proxies](#client-ip-attribution-behind-proxies).
- `PATCHY_MAX_HTML_BYTES` caps the size of a single HTML document (default 524288 = 512 KiB).
- `PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE`, `PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE`, `PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE`, and `PATCHY_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE` are decimal integers from `1` through `10000`. Defaults are `60`, `20`, `5`, and `10`.
- `PATCHY_LIVE_DRAFTS_PER_TOKEN` is a decimal integer from `1` through `1000000` and defaults to `1000`. See [Per-token draft quotas](#per-token-draft-quotas).
- `PATCHY_ALLOW_SELF_SERVICE_TOKENS` is a strict `true`/`false` value and defaults to `false`. It gates the self-service mint route (`POST /api/tokens/self-service`) and nothing else; while it is `false` that route refuses every caller and your instance keeps its admin-only token posture. It never admits an upload that carries no bearer token. See [Self-service minting](#self-service-minting).
- `PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY` is a decimal integer from `1` through `1000000` and defaults to `5`. It applies only while self-service minting is on.
- `PATCHY_POSTHOG_API_KEY` and `PATCHY_POSTHOG_HOST` configure server-side analytics. Leave the key unset — the default — and your instance reports nothing at all. See [Server-side analytics](#server-side-analytics).
- Uploads are authenticated on every path. A missing bearer token, and any malformed, invalid, revoked, or insufficiently scoped credential, is an authentication or authorization failure with no unauthenticated fallback.
- When running from source, the `json` metadata driver and `filesystem` storage driver write under `.local/` by default. An image built from this checkout overrides those path defaults to `/data` as shown above. Both modes need no external services and suit a quick or single-instance self-host. For a durable multi-instance deployment, use `postgres` and a shared object store (`azure-blob`).

### Abuse protection and rate limits

The server applies deterministic fixed-window in-memory limits inside each server process:

- Protected `/api` requests are limited to `PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE` attempts per minute per canonical Fastify `request.ip`. That IP follows `PATCHY_TRUST_PROXY`, so configure the proxy boundary before relying on IP-based buckets.
- Authenticated upload requests are limited to `PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE` attempts per minute per API token database identity. Rotating the raw bearer secret for the same token record does not create a fresh upload bucket.
- `PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE` limits self-service mints per minute per canonical Fastify `request.ip`, on instances where minting is enabled. It is keyed by address rather than by token because a caller asking for its first token has no token to key on.
- Draft _creates_ are additionally limited to `PATCHY_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE` per minute per creating token. An upload carrying a `patchId` is an update and never consumes this bucket. Because the request body decides create versus update, this bucket is consumed after body parsing, unlike the buckets above.

When a bucket is exceeded, the server returns HTTP `429` with JSON `{ "ok": false, "code": "rate_limited", ... }` and an integer `Retry-After` header. Each limiter tracks up to `10000` live keys in memory. If all live key slots are occupied, an unseen key receives the same bounded `429` response until the earliest live bucket resets. Live buckets are never evicted to make room for an unseen key, because eviction would let an attacker bypass limits by cycling key values.

Expired buckets are pruned deterministically when the process observes a request at or after their reset boundary. A request exactly at the reset time starts a new fixed window for that key. Public `GET /healthz` and draft viewer routes under `/d/...` do not consume protected API or upload buckets.

These counters are process-local and memory-only. They reset on restart and are not shared across Node processes, containers, or replicas. For multi-instance deployments, treat them as a local safety net and add an ingress, load balancer, CDN, or shared external rate limiter if you need a global limit.

### Per-token draft quotas

Only per-minute limits live in memory. A long-window quota is derived from the database on every attempt, so restarting the process never hands anyone a fresh allowance.

`PATCHY_LIVE_DRAFTS_PER_TOKEN` caps how many _live_ drafts one token may hold at once. A draft is live while it is neither deleted nor disabled, and it belongs to the token that created it — a later update by a different token never moves it between tallies. Deleting or disabling a draft returns its slot immediately.

The cap is per token, not per account: two tokens on one account each get the full allowance. It applies uniformly, with no exemption for `admin`-scoped tokens.

A create that would exceed the quota is rejected with HTTP `403` and JSON `{ "ok": false, "code": "live_patch_quota_exceeded", "quota": <cap>, "error": "..." }`, where the error text names the cap. Updates are never rejected by this quota.

Unlike the buckets above, this ceiling is not process-local: it is recounted from the metadata store on every create, so restarting or scaling the server does not reset it.

### Draft expiry and pinned drafts

Every draft carries a retention clock. Publishing a new version restarts it at 90 days, and serving a draft with less than 30 days left tops it back up to 30 — so a page that is still read stays up, and one that nobody visits runs out. A draft whose clock has run out immediately stops serving (`404`) and is refused as an update target.

Expiry is a **hard delete**. An in-process sweep runs hourly, and once at startup, in the same process that serves pages: it deletes the expired draft's record, its versions, its upload events, and the stored HTML behind them. No copy is kept anywhere and there is no restore — republishing is the only way back, and it produces a new draft with a new URL. Deleted and disabled drafts age out the same way, which is what eventually frees their storage. The sweep is safe to run while serving and takes at most 1000 drafts per run, so a large backlog drains across several runs.

Because the record is deleted before its stored objects, a crash mid-sweep can leave an unreachable HTML object behind. Nothing serves it and no later run will find it, so reclaim it from `PATCHY_STORAGE_DIR` (or your blob container) by hand if you care about the bytes.

An expired draft still counts against its creator's [draft quota](#per-token-draft-quotas) until the sweep removes it, because its row and its content are both still there.

To exempt a page the instance itself maintains — a welcome page, your own docs — pin it with an `admin`-scoped token:

```sh
# Keep the credential out of argv: put the header in an owner-only file first.
PIN_TMP_DIR="$(mktemp -d)" && chmod 700 "$PIN_TMP_DIR"
(umask 077; printf 'Authorization: Bearer %s\n' "$ADMIN_TOKEN" \
  > "$PIN_TMP_DIR/auth.headers")

curl --fail --silent --show-error --request POST \
  --header "@$PIN_TMP_DIR/auth.headers" \
  "$API_URL/api/patches/$DRAFT_ID/pin"
# {"ok":true,"pinned":true}

rm -rf "$PIN_TMP_DIR"
```

`POST /api/patches/:patchId/unpin` reverses it. Both return `404` for a draft that is not there, and `403` for a token without the `admin` scope — including the token that created the draft. A pinned draft is never expired and never swept, however long it sits; in every other respect it is ordinary. Its clock keeps running underneath the pin and visits keep topping it up, so unpinning hands it back to whatever time it had left: a page still being read keeps its 30-day visit window, and one nobody has read in months expires at once.

A pin only ever holds a page that is **in service**. Deleting or disabling a draft ends its pin, and pinning a draft that is already deleted or disabled returns `404` — so a pin can never keep a moderated or withdrawn page's storage alive. Unpinning works on any draft that still has a row, which means a pin can never get stuck out of reach.

### Self-service minting

Off by default. Leave `PATCHY_ALLOW_SELF_SERVICE_TOKENS=false` and your instance behaves exactly as it always has: the only way to get a token is for you to issue one through the admin-scoped `POST /api/tokens`, and `POST /api/tokens/self-service` refuses every caller with HTTP `403` and `{ "ok": false, "code": "self_service_disabled", "error": "..." }`.

Setting it to `true` opens one route, `POST /api/tokens/self-service`. It is the only API route that accepts a request with no `Authorization` header — requiring a credential to obtain your first credential would be circular. It takes no input at all: an absent body and `{}` are both accepted, and nothing in the request influences the result. On success it answers HTTP `201` with `{ "ok": true, "token": "pp_..." }`. **That response is the only time the plaintext exists on your instance**; only its hash is stored, so a lost token cannot be recovered by you or anyone else, and the remedy is minting a fresh one.

Each mint creates a fresh principal — the internal ownership row behind a token — holding exactly one `upload`-scoped token. That reuses the ownership checks already described above rather than adding a second authorization model, so a self-service token can create drafts and update or delete only the ones it created. It is never `admin`, so it cannot moderate another principal's drafts and cannot issue further tokens through `POST /api/tokens`. The principal is marked as self-service minted, and every mint records its source address and time.

Two guardrails limit minting, and they are deliberately different in kind:

- `PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE` is the in-memory bucket, per source address. Exceeding it returns HTTP `429` with `{ "ok": false, "code": "rate_limited", "retryAfterSeconds": <n>, "error": "..." }` and a `Retry-After` header. Like every other limiter here it is process-local and resets on restart.
- `PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY` is counted from the metadata store on every mint, over a **rolling** 24 hours ending now rather than a calendar day — a calendar day resets at an hour every caller can predict. Exceeding it returns HTTP `429` with `{ "ok": false, "code": "mint_quota_exceeded", "quota": <cap>, "error": "..." }`. Restarting or redeploying does not reset it.

Both key on the canonical Fastify `request.ip`, which follows `PATCHY_TRUST_PROXY`. **Configure your proxy boundary before enabling minting**: behind an unconfigured proxy every request appears to come from one address, which collapses all callers into a single quota, and a wrongly trusted one lets a caller choose its own bucket by forging a header. Mints the server cannot attribute to an address share one bucket rather than escaping the count.

A self-service token's drafts are ordinary drafts in every respect that matters to the guardrails above: they carry the same retention clock, are swept on the same terms, and count against the same [per-token draft quota](#per-token-draft-quotas). Minting creates no exemption from anything.

Turning the flag back off stops new mints; it does not revoke tokens already minted or remove the drafts they own.

### Server-side analytics

Off by default. Leave `PATCHY_POSTHOG_API_KEY` unset and your instance builds no analytics client, opens no connection, and reports nothing — this is the default posture and nothing else in the server changes with it.

Setting a key turns on capture for six business events, and only those six:

| Event            | When                                              | Properties                                            |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `token.minted`   | A token is issued, self-service or by an operator | `apiTokenId`, `selfService`                           |
| `draft.created`  | An upload creates a draft                         | `draftId`, `apiTokenId`, `versionNumber`, `htmlBytes` |
| `draft.updated`  | An upload adds a version                          | `draftId`, `apiTokenId`, `versionNumber`, `htmlBytes` |
| `draft.disabled` | A draft is disabled                               | `draftId`, `admin`                                    |
| `draft.deleted`  | A draft is deleted                                | `draftId`, `admin`                                    |
| `draft.expired`  | The expiry sweep takes a draft                    | `draftId`, `versionsRemoved`                          |

Two properties of this are load-bearing rather than incidental:

- **Readers stay unwatched.** Serving a draft is deliberately not an event. No analytics JavaScript is ever added to a served page — the draft content security policy permits no script source of any kind — no cookie is set, and no event carries a source address, page content, a filename, or a URL. Events are attributed to the principal that acted; the ones no principal performed are attributed to the instance.
- **Capture never affects a response.** Events are handed off without being awaited, capture failures are swallowed and logged, and requests to the analytics backend time out in three seconds. An analytics outage is invisible to everyone publishing or reading.

`PATCHY_POSTHOG_HOST` points capture somewhere other than the default `https://us.i.posthog.com` — PostHog's EU cloud, or a self-hosted PostHog. It must be an `http` or `https` URL; a malformed one fails startup rather than silently discarding every event. On shutdown the server gives whatever is still queued three seconds to go out, then stops waiting.

### JSON metadata durability

The `json` driver supports one server process. Within that process, database objects targeting the same backing-directory filesystem identity — including containing-directory bind-mount aliases and case aliases on case-insensitive filesystems — share one mutation serializer, even before the final file exists. Queue identity includes every existing ancestor, so creating a missing parent cannot move a later mutation onto a different queue. Each mutation completes its read, state-shape validation, update, and commit before the next mutation starts. This coordination is strictly process-local; the driver does not provide interprocess locking.

The final `PATCHY_DB_FILE` path may be absent or a singly linked regular file, and every user-configurable parent component must be a real directory rather than a symbolic link (Darwin's fixed `/etc`, `/tmp`, and `/var` compatibility paths are treated as platform roots). Live or dangling parent-directory symlinks, live or dangling final-component symlinks, multiply linked regular files (hard links), FIFOs, directories, sockets, devices, and other special files are unsupported and rejected without changing the path, alias, or target. Existing invalid-UTF-8, malformed, truncated, unreadable, or invalid-shape files are likewise rejected without replacement. Mutated state must be losslessly JSON-representable; unsafe state is rejected before a temporary commit file is created.

For a fresh path, missing parent directories are created incrementally and each new directory entry is flushed through its containing directory where the platform supports directory flushing. On first use in each process, the existing ancestor chain is also re-flushed; if flushing a newly created directory's parent fails, a retry must complete that ancestor flush before any commit can succeed. Each commit acquires the target-directory handle before committing, writes and flushes a uniquely named temporary file in that directory, atomically renames it over the primary file, and flushes the already-open directory handle. A failure before rename leaves the primary uncommitted. If rename succeeds but the directory flush fails, the operation reports an **indeterminate commit outcome**; inspect the database state before retrying. On filesystems that honor same-directory atomic replacement, readers see either the previous complete state or the new complete state, not a partially written primary.

On Linux, do not configure `PATCHY_DB_FILE` as a single-file bind mount. Linux does not permit rename-based replacement of that mount point, so the driver rejects the commit without modifying the mounted file. Mount a writable containing directory instead, then place `PATCHY_DB_FILE` inside it. Crash and power-loss durability still depends on the operating system, filesystem, mount, and storage hardware honoring rename and flush semantics; network, FUSE, overlay/container, and synchronized filesystems may provide weaker guarantees. Keep backups.

Do not share one JSON file between multiple server processes, workers, or replicas. That setup can lose updates. Use `postgres` and a shared object store for a multi-process or multi-replica deployment.

### Storage drivers

- `filesystem` — writes HTML objects to `PATCHY_STORAGE_DIR` on local disk. Simplest option.
- `azure-blob` — Azure Blob Storage, authenticating with a connection string or, when none is set, a managed identity.

## Database migration

If you use the `postgres` driver, the server migrates the schema and provisions the bootstrap token itself on startup; the snippet below only readies the token it needs. It uses a pre-existing non-empty `PATCHY_BOOTSTRAP_API_TOKEN` first. When it is absent, the snippet reads `PATCHY_BOOTSTRAP_TOKEN_FILE` or creates and reuses the protected default token file:

```sh
(
set +x
BOOTSTRAP_TOKEN_CREATED=false
BOOTSTRAP_TOKEN_READY=false

migration_cleanup() {
  unset PATCHY_BOOTSTRAP_API_TOKEN
  if test "$BOOTSTRAP_TOKEN_CREATED" = true &&
     test "$BOOTSTRAP_TOKEN_READY" != true; then
    rm -f "$BOOTSTRAP_TOKEN_FILE"
  fi
}
trap 'migration_cleanup' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if test "${PATCHY_BOOTSTRAP_API_TOKEN+x}" = x; then
  if test -z "$PATCHY_BOOTSTRAP_API_TOKEN"; then
    printf 'PATCHY_BOOTSTRAP_API_TOKEN is set but empty.\n' >&2
    exit 1
  fi
else
  GENERATE_BOOTSTRAP_TOKEN=false
  if test -n "${PATCHY_BOOTSTRAP_TOKEN_FILE:-}"; then
    BOOTSTRAP_TOKEN_FILE=$PATCHY_BOOTSTRAP_TOKEN_FILE
  else
    GENERATE_BOOTSTRAP_TOKEN=true
    BOOTSTRAP_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/patchy/bootstrap-api-token"
    BOOTSTRAP_TOKEN_DIR=$(dirname "$BOOTSTRAP_TOKEN_FILE")
    if ! mkdir -p "$BOOTSTRAP_TOKEN_DIR" || ! chmod 700 "$BOOTSTRAP_TOKEN_DIR"; then
      printf 'Could not secure the bootstrap token directory.\n' >&2
      exit 1
    fi
  fi

  if test -L "$BOOTSTRAP_TOKEN_FILE"; then
    printf 'The bootstrap token file must not be a symbolic link.\n' >&2
    exit 1
  fi
  if test -f "$BOOTSTRAP_TOKEN_FILE"; then
    :
  elif test "$GENERATE_BOOTSTRAP_TOKEN" = true &&
       ! test -e "$BOOTSTRAP_TOKEN_FILE"; then
    BOOTSTRAP_TOKEN_CREATED=true
    if ! (umask 077; set -C; openssl rand -hex 32 > "$BOOTSTRAP_TOKEN_FILE"); then
      rm -f "$BOOTSTRAP_TOKEN_FILE"
      printf 'Could not generate the bootstrap API token.\n' >&2
      exit 1
    fi
  else
    printf 'The bootstrap token path must be an existing regular file.\n' >&2
    exit 1
  fi
  if test "$GENERATE_BOOTSTRAP_TOKEN" = true; then
    if ! chmod 600 "$BOOTSTRAP_TOKEN_FILE" ||
       test -L "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -f "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -r "$BOOTSTRAP_TOKEN_FILE"; then
      printf 'Could not verify the generated bootstrap token file.\n' >&2
      exit 1
    fi
    BOOTSTRAP_TOKEN_MODE=$(LC_ALL=C ls -ld "$BOOTSTRAP_TOKEN_FILE" | awk '{ print $1 }')
    case "$BOOTSTRAP_TOKEN_MODE" in
      -rw-------|-rw-------@|-rw-------.) ;;
      *)
        printf 'The generated bootstrap token file must have mode 0600.\n' >&2
        exit 1
        ;;
    esac
  else
    if test -L "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -f "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -r "$BOOTSTRAP_TOKEN_FILE"; then
      printf 'The custom bootstrap token must be a readable regular file, not a symbolic link.\n' >&2
      exit 1
    fi
    BOOTSTRAP_TOKEN_MODE=$(LC_ALL=C ls -ld "$BOOTSTRAP_TOKEN_FILE" | awk '{ print $1 }')
    case "$BOOTSTRAP_TOKEN_MODE" in
      -r--------|-r--------@|-r--------.|-rw-------|-rw-------@|-rw-------.) ;;
      *)
        printf 'The custom bootstrap token file must have mode 0400 or 0600.\n' >&2
        exit 1
        ;;
    esac
  fi

  PATCHY_BOOTSTRAP_API_TOKEN=''
  IFS= read -r PATCHY_BOOTSTRAP_API_TOKEN < "$BOOTSTRAP_TOKEN_FILE" ||
    test -n "$PATCHY_BOOTSTRAP_API_TOKEN" || {
      printf 'Could not read a non-empty bootstrap API token.\n' >&2
      exit 1
    }
  if test -z "$PATCHY_BOOTSTRAP_API_TOKEN"; then
    printf 'Could not read a non-empty bootstrap API token.\n' >&2
    exit 1
  fi
fi
BOOTSTRAP_TOKEN_READY=true
export PATCHY_BOOTSTRAP_API_TOKEN
PATCHY_DB_DRIVER=postgres \
DATABASE_URL=postgres://user:password@host:5432/patchy \
pnpm --filter @patchy/server start
)
```

The server migrates the database on startup, before it listens: every pending schema migration runs in one transaction through Effect's Migrator, recorded in the `schema_migrations` ledger so a restart is a no-op. Together they create the `accounts`, `api_tokens`, `drafts`, `draft_versions`, `upload_events` and `token_mints` tables and their indexes. It then — when `PATCHY_BOOTSTRAP_API_TOKEN` is set — provisions a bootstrap account and a bootstrap API token with `admin` and `upload` scopes. The `json` driver applies the same migrations and initialization automatically on startup too. Adding a migration is documented in `packages/db/README.md`.

## Running the server

The same credential-loading block serves both source startup paths. It defaults to a production build and start; set `PATCHY_SERVER_MODE=development` before running it for auto-reload. A pre-existing credential is copied into a shell-local variable and immediately removed from the inherited environment. The selected server child receives it, while the production build does not.

```sh
(
set +x
BOOTSTRAP_TOKEN_CREATED=false
BOOTSTRAP_TOKEN_READY=false
SERVER_BOOTSTRAP_API_TOKEN=''
SERVER_MODE="${PATCHY_SERVER_MODE:-production}"

server_cleanup() {
  unset PATCHY_BOOTSTRAP_API_TOKEN SERVER_BOOTSTRAP_API_TOKEN
  if test "$BOOTSTRAP_TOKEN_CREATED" = true &&
     test "$BOOTSTRAP_TOKEN_READY" != true; then
    rm -f "$BOOTSTRAP_TOKEN_FILE"
  fi
}
trap 'server_cleanup' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if test "${PATCHY_BOOTSTRAP_API_TOKEN+x}" = x; then
  if test -z "$PATCHY_BOOTSTRAP_API_TOKEN"; then
    printf 'PATCHY_BOOTSTRAP_API_TOKEN is set but empty.\n' >&2
    exit 1
  fi
  SERVER_BOOTSTRAP_API_TOKEN=$PATCHY_BOOTSTRAP_API_TOKEN
  unset PATCHY_BOOTSTRAP_API_TOKEN
else
  GENERATE_BOOTSTRAP_TOKEN=false
  if test -n "${PATCHY_BOOTSTRAP_TOKEN_FILE:-}"; then
    BOOTSTRAP_TOKEN_FILE=$PATCHY_BOOTSTRAP_TOKEN_FILE
  else
    GENERATE_BOOTSTRAP_TOKEN=true
    BOOTSTRAP_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/patchy/bootstrap-api-token"
    BOOTSTRAP_TOKEN_DIR=$(dirname "$BOOTSTRAP_TOKEN_FILE")
    if ! mkdir -p "$BOOTSTRAP_TOKEN_DIR" || ! chmod 700 "$BOOTSTRAP_TOKEN_DIR"; then
      printf 'Could not secure the bootstrap token directory.\n' >&2
      exit 1
    fi
  fi

  if test -L "$BOOTSTRAP_TOKEN_FILE"; then
    printf 'The bootstrap token file must not be a symbolic link.\n' >&2
    exit 1
  fi
  if test -f "$BOOTSTRAP_TOKEN_FILE"; then
    :
  elif test "$GENERATE_BOOTSTRAP_TOKEN" = true &&
       ! test -e "$BOOTSTRAP_TOKEN_FILE"; then
    BOOTSTRAP_TOKEN_CREATED=true
    if ! (umask 077; set -C; openssl rand -hex 32 > "$BOOTSTRAP_TOKEN_FILE"); then
      rm -f "$BOOTSTRAP_TOKEN_FILE"
      printf 'Could not generate the bootstrap API token.\n' >&2
      exit 1
    fi
  else
    printf 'The bootstrap token path must be an existing regular file.\n' >&2
    exit 1
  fi
  if test "$GENERATE_BOOTSTRAP_TOKEN" = true; then
    if ! chmod 600 "$BOOTSTRAP_TOKEN_FILE" ||
       test -L "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -f "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -r "$BOOTSTRAP_TOKEN_FILE"; then
      printf 'Could not verify the generated bootstrap token file.\n' >&2
      exit 1
    fi
    BOOTSTRAP_TOKEN_MODE=$(LC_ALL=C ls -ld "$BOOTSTRAP_TOKEN_FILE" | awk '{ print $1 }')
    case "$BOOTSTRAP_TOKEN_MODE" in
      -rw-------|-rw-------@|-rw-------.) ;;
      *)
        printf 'The generated bootstrap token file must have mode 0600.\n' >&2
        exit 1
        ;;
    esac
  else
    if test -L "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -f "$BOOTSTRAP_TOKEN_FILE" ||
       ! test -r "$BOOTSTRAP_TOKEN_FILE"; then
      printf 'The custom bootstrap token must be a readable regular file, not a symbolic link.\n' >&2
      exit 1
    fi
    BOOTSTRAP_TOKEN_MODE=$(LC_ALL=C ls -ld "$BOOTSTRAP_TOKEN_FILE" | awk '{ print $1 }')
    case "$BOOTSTRAP_TOKEN_MODE" in
      -r--------|-r--------@|-r--------.|-rw-------|-rw-------@|-rw-------.) ;;
      *)
        printf 'The custom bootstrap token file must have mode 0400 or 0600.\n' >&2
        exit 1
        ;;
    esac
  fi

  SERVER_BOOTSTRAP_API_TOKEN=''
  IFS= read -r SERVER_BOOTSTRAP_API_TOKEN < "$BOOTSTRAP_TOKEN_FILE" ||
    test -n "$SERVER_BOOTSTRAP_API_TOKEN" || {
      printf 'Could not read a non-empty bootstrap API token.\n' >&2
      exit 1
    }
  if test -z "$SERVER_BOOTSTRAP_API_TOKEN"; then
    printf 'Could not read a non-empty bootstrap API token.\n' >&2
    exit 1
  fi
fi
BOOTSTRAP_TOKEN_READY=true

case "$SERVER_MODE" in
  development)
    PATCHY_BOOTSTRAP_API_TOKEN=$SERVER_BOOTSTRAP_API_TOKEN
    export PATCHY_BOOTSTRAP_API_TOKEN
    pnpm --filter @patchy/server dev
    ;;
  production)
    if ! pnpm --filter @patchy/server build; then
      printf 'The production build failed; the server was not started.\n' >&2
      exit 1
    fi
    PATCHY_BOOTSTRAP_API_TOKEN=$SERVER_BOOTSTRAP_API_TOKEN
    export PATCHY_BOOTSTRAP_API_TOKEN
    pnpm --filter @patchy/server start
    ;;
  *)
    printf 'PATCHY_SERVER_MODE must be development or production.\n' >&2
    exit 1
    ;;
esac
)
```

The server listens on `0.0.0.0:$PORT` and exposes a `GET /healthz` endpoint that returns exactly `{"ok":true}` for health checks. To build a container image from your checkout, run `pnpm --filter @patchy/server docker`; it tags the result `patchy-server` (see `apps/server/Dockerfile`).

## Minting API tokens

The bootstrap token (`PATCHY_BOOTSTRAP_API_TOKEN`) is itself a valid API token with `admin` and `upload` scopes. You can use it to authenticate the CLI, but the better practice is to use it once to mint scoped, per-client tokens.

`POST /api/tokens` requires a token with the `admin` scope (the bootstrap token has it). The request body accepts an optional `name` and `scopes` array; if `scopes` is omitted it defaults to `["upload"]`. The snippet uses a pre-existing non-empty `PATCHY_BOOTSTRAP_API_TOKEN` first and reads an owner-only regular token file only when the variable is absent. It captures the one-time response in a protected directory, validates the token without printing it, sends it to `auth set` through stdin, and verifies the saved credential. Any failure after the server mints the token retains the protected response or extracted token and prints only its recovery path.

```sh
(
set +x
API_URL='https://post.example.com'
PATCHY_API_URL=$API_URL
export PATCHY_API_URL
unset PATCHY_API_TOKEN
MINT_TMP_DIR=''
AUTH_HEADER_FILE=''
RESPONSE_FILE=''
MINTED_TOKEN_FILE=''
MINT_PRESERVE=false

mint_cleanup() {
  unset PATCHY_BOOTSTRAP_API_TOKEN
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

if test "${PATCHY_BOOTSTRAP_API_TOKEN+x}" = x; then
  if test -z "$PATCHY_BOOTSTRAP_API_TOKEN"; then
    printf 'PATCHY_BOOTSTRAP_API_TOKEN is set but empty.\n' >&2
    exit 1
  fi
else
  BOOTSTRAP_TOKEN_FILE="${PATCHY_BOOTSTRAP_TOKEN_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/patchy/bootstrap-api-token}"
  if test -L "$BOOTSTRAP_TOKEN_FILE" ||
     ! test -f "$BOOTSTRAP_TOKEN_FILE" ||
     ! test -r "$BOOTSTRAP_TOKEN_FILE"; then
    printf 'The bootstrap token must be a readable regular file, not a symbolic link.\n' >&2
    exit 1
  fi
  BOOTSTRAP_TOKEN_MODE=$(LC_ALL=C ls -ld "$BOOTSTRAP_TOKEN_FILE" | awk '{ print $1 }')
  case "$BOOTSTRAP_TOKEN_MODE" in
    -r--------|-r--------@|-r--------.|-rw-------|-rw-------@|-rw-------.) ;;
    *)
      printf 'The bootstrap token file must have mode 0400 or 0600.\n' >&2
      exit 1
      ;;
  esac
  PATCHY_BOOTSTRAP_API_TOKEN=''
  IFS= read -r PATCHY_BOOTSTRAP_API_TOKEN < "$BOOTSTRAP_TOKEN_FILE" ||
    test -n "$PATCHY_BOOTSTRAP_API_TOKEN" || {
      printf 'Could not read a non-empty bootstrap API token.\n' >&2
      exit 1
    }
  if test -z "$PATCHY_BOOTSTRAP_API_TOKEN"; then
    printf 'Could not read a non-empty bootstrap API token.\n' >&2
    exit 1
  fi
fi
if ! MINT_TMP_DIR="$(mktemp -d)" || ! chmod 700 "$MINT_TMP_DIR"; then
  printf 'Could not create the token-mint temporary directory.\n' >&2
  exit 1
fi
AUTH_HEADER_FILE="$MINT_TMP_DIR/auth.headers"
RESPONSE_FILE="$MINT_TMP_DIR/response.json"
MINTED_TOKEN_FILE="$MINT_TMP_DIR/minted-upload-token"
if ! (umask 077; printf 'Authorization: Bearer %s\n' \
  "$PATCHY_BOOTSTRAP_API_TOKEN" > "$AUTH_HEADER_FILE") ||
   ! chmod 600 "$AUTH_HEADER_FILE" ||
   ! (umask 077; : > "$RESPONSE_FILE") ||
   ! chmod 600 "$RESPONSE_FILE"; then
  printf 'Could not create protected token-mint files.\n' >&2
  exit 1
fi
unset PATCHY_BOOTSTRAP_API_TOKEN

if ! curl --fail --silent --show-error --request POST \
  --output "$RESPONSE_FILE" \
  --header "@$AUTH_HEADER_FILE" \
  --header "Content-Type: application/json" \
  --data '{"name":"laptop","scopes":["upload"]}' \
  "$API_URL/api/tokens"; then
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

if ! patchy auth set --token-stdin --api-url "$API_URL" < "$MINTED_TOKEN_FILE"; then
  MINT_PRESERVE=true
  printf 'Credential save failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit 1
fi
if ! patchy whoami; then
  MINT_PRESERVE=true
  printf 'Credential verification failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit 1
fi
MINT_PRESERVE=false
)
```

The server's HTTP 201 body has this shape, but the command above never writes it to the terminal:

```json
{
  "ok": true,
  "apiToken": { "id": "tok_...", "name": "laptop" },
  "token": "pp_..."
}
```

After the minting block succeeds, the CLI is already configured for your instance and the new scoped token has been verified.

## Pointing the CLI at your instance

The CLI defaults to `http://localhost:3000`, so any other instance has to be named explicitly — which is what the minting block above does when it saves the new credential against `--api-url`. On another machine, use this fail-closed quick start with a scoped token in a protected owner-readable file:

```sh
(
set -eu
set +x
PATCHY_API_URL='https://post.example.com'
export PATCHY_API_URL
unset PATCHY_API_TOKEN
UPLOAD_TOKEN_FILE="${PATCHY_UPLOAD_TOKEN_FILE:?Set PATCHY_UPLOAD_TOKEN_FILE to the protected scoped-token file}"
if test -L "$UPLOAD_TOKEN_FILE" ||
   ! test -f "$UPLOAD_TOKEN_FILE" ||
   ! test -r "$UPLOAD_TOKEN_FILE"; then
  printf 'The upload token must be a readable regular file, not a symbolic link.\n' >&2
  exit 1
fi
UPLOAD_TOKEN_MODE=$(LC_ALL=C ls -ld "$UPLOAD_TOKEN_FILE" | awk '{ print $1 }')
case "$UPLOAD_TOKEN_MODE" in
  -r--------|-r--------@|-r--------.|-rw-------|-rw-------@|-rw-------.) ;;
  *)
    printf 'The upload token file must have mode 0400 or 0600.\n' >&2
    exit 1
    ;;
esac
patchy auth set --token-stdin --api-url "$PATCHY_API_URL" < "$UPLOAD_TOKEN_FILE"
patchy whoami
patchy validate ./plan.html
patchy upload ./plan.html
)
```

An upload without a draft ID creates a draft with a cryptographically generated server ID. To add a version to a specific draft, assign the ID returned by the server and pass the quoted value:

```sh
DRAFT_ID='abc123def456'
patchy upload ./plan.html --draft "$DRAFT_ID"
```

The `--draft` option is update-only: the target must already be active and owned by the authenticated account, and unknown, deleted, disabled, or unowned targets all return the same generic unavailable response without creating a draft. Use `--new` for an explicit create; `--new` and `--draft` cannot be combined.

`patchy upload` needs a credential: `PATCHY_API_TOKEN`, or a token stored by `auth set`. With neither, the request carries no bearer token and the server rejects it with 401. Authentication failures are returned directly and are never retried without credentials. The CLI's `--anonymous` flag is retired and no longer selects a working mode; the credential-free request it produces is rejected with 401 as well.

`auth set` reads the token from a non-echoing terminal prompt. Automation that needs to persist credentials must explicitly pipe one token to `--token-stdin`:

```sh
printf '%s' "$TOKEN" | patchy auth set --token-stdin --api-url https://post.example.com
```

Alternatively, CI can set `PATCHY_API_URL` and `PATCHY_API_TOKEN` directly on ordinary authenticated commands such as `whoami` and `upload`, skipping `auth set` entirely. `auth set` does not read `PATCHY_API_TOKEN`.

## Deployment notes

The server serves plain HTTP and does not terminate TLS itself. Put it behind a reverse proxy or platform ingress (nginx, Caddy, a cloud load balancer, Azure Container Apps ingress, etc.) that terminates TLS and forwards to `$PORT`, and set `PATCHY_PUBLIC_BASE_URL` to the public HTTPS origin. Provide `DATABASE_URL` and any storage credentials through your platform's secret management rather than committing them.

### Client IP attribution behind proxies

Fastify's `request.ip` is the server's single attributed client address. Uploads persist that value in the `source_ip` fields of `draft_versions` and `upload_events`; code that needs the attributed client address must consume the same value rather than reparsing forwarding headers.

When `PATCHY_TRUST_PROXY` is absent, Fastify ignores `X-Forwarded-For` and `request.ip` is the direct socket peer. This is the safe setting for a direct deployment. A defined blank or whitespace-only value is an error, not another spelling of "off".

The setting accepts one or more comma-separated literal IPv4/IPv6 addresses or CIDR networks. Fastify walks from the socket outward while each address belongs to the configured set; the first address outside the set becomes `request.ip`. Hop counts are rejected: they cannot verify the connecting peer.

Values such as hop counts (`1` through `32`), `0`, negative or fractional counts, `true`, `false`, `all`, `*`, empty list entries, malformed addresses, blanket `/0` networks, deprecated `::` plus dotted-IPv4 transitional aliases, IPv4-mapped IPv6 aliases, and CIDR lists whose effective union covers all IPv4 or all IPv6 addresses are rejected. IPv6 entries with dotted IPv4 tails must use canonical decimal octets; ambiguous forms with leading zeroes are rejected so OpenTofu and the Node.js runtime interpret the same trust boundary. Network entries are syntax-only until you replace them with the proxy addresses actually observed in your environment; for example:

```env
# Documentation addresses only; replace both entries with observed proxy egress ranges.
PATCHY_TRUST_PROXY=192.0.2.10,2001:db8:1234::/48
```

For one nginx proxy, make nginx replace any client-supplied value and set `PATCHY_TRUST_PROXY` to the address or CIDR nginx uses when connecting to the server:

```nginx
location / {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://patchy-server:3000;
}
```

```env
# Replace with the address or CIDR nginx uses when connecting to the server.
PATCHY_TRUST_PROXY=192.0.2.10
```

nginx also provides `$proxy_add_x_forwarded_for`, which appends its peer address to an existing header. If you use it in a multi-proxy topology, validate the upstream before preserving its header and configure the server for the whole observed chain. See nginx's [`proxy_set_header` and `$proxy_add_x_forwarded_for` documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

For a single Caddy proxy, its normal reverse proxy behavior sets the forwarded headers and disregards client-supplied forwarded values. With no other path to the server, set `PATCHY_TRUST_PROXY` to the address or CIDR Caddy uses when connecting to the server:

```caddyfile
post.example.com {
    reverse_proxy patchy-server:3000
}
```

```env
# Replace with the address or CIDR Caddy uses when connecting to the server.
PATCHY_TRUST_PROXY=192.0.2.10
```

If another proxy or CDN precedes Caddy, configure Caddy's own trusted-proxy boundary first and then configure the server for the chain Caddy actually sends. See Caddy's [`reverse_proxy` forwarding-header behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).

For an invariant two-proxy path such as `client -> CDN/load balancer -> nginx/Caddy -> server`, list the observed addresses or CIDRs of both proxies:

```env
# Documentation addresses only; replace with the observed proxy egress ranges.
PATCHY_TRUST_PROXY=192.0.2.10,198.51.100.0/24
```

Do not trust broad private networks shared with untrusted workloads. Prevent clients from reaching the server around the trusted proxy, and test every public hostname with a deliberately spoofed `X-Forwarded-For` value before relying on the attribution for audit.

## Security

No instance publishes without credentials: every upload requires a bearer token, and no configuration accepts one that carries none. `PATCHY_ALLOW_SELF_SERVICE_TOKENS` defaults to `false`; keep it `false` unless you intentionally plan to accept public token-minting traffic and have an appropriate external abuse-control layer, and read [Self-service minting](#self-service-minting) — particularly the proxy-boundary warning — before turning it on. An ordinary `upload` token can disable or delete only the drafts it owns; the `admin` scope additionally moderates any principal's draft, which is the operator's takedown path. Treat `PATCHY_BOOTSTRAP_API_TOKEN` as a secret, and remember that draft viewer URLs are public and unlisted — anyone with a link can view the rendered HTML unless you add your own viewer access controls.

### Moderation

Complaints about a page reach the operator out of band — nothing on a served page files one. Four admin-scoped endpoints then resolve one end to end, so no operator ever edits rows by hand:

- `GET /api/patches/:patchId` — the draft's owning principal and the token that created it. It answers for a draft that is already disabled, deleted, or expired, because those are exactly the ones complaints arrive about. Once the expiry sweep has hard-deleted the draft, the row is gone and this answers 404 — a complaint can outlive the page it was about.
- `GET /api/principals/:principalId/patches` — that principal's other drafts, newest first. Deleted drafts are omitted; disabled ones are not. A `truncated` answer means the principal holds more than one page: **deleting** drafts is what reveals the rest, because deleting is what removes them from this list — disabling a draft leaves it on the page.
- `POST /api/patches/:patchId/disable` and `DELETE /api/patches/:patchId` — per-draft takedown, as above.
- `POST /api/tokens/:apiTokenId/revoke` — revoke the token.

Revocation is a state the token enters, never a deletion: the row survives with its mint provenance, and a revoked token authenticates nothing — the caller sees the same 401 any bad credential gets. Revoking twice is the same answer with the original timestamp, because that moment is when the token's drafts stopped receiving visit top-ups. Those drafts stay up and run out whatever retention clock they had left; nothing extends them again. There is no un-revoke; issue a replacement token instead.

Two things revocation does not do. A **pinned** draft is exempt from expiry, so revoking its creating token will never age it out — if the moderation read shows `pinnedAt`, unpin, disable, or delete the page yourself. And revocation is scoped to the token, not the principal: where an operator has minted several tokens on one principal, a surviving sibling can still update that principal's drafts and reset their retention clock. Self-service mints are 1:1 with their principal, so this only arises for operator-created tokens.
