# Patchy Cloud API

Rendered from `PatchyApi` in `packages/api` by `pnpm --filter @patchy/api render-docs`. Do not
edit by hand: a test fails when this file and the schemas disagree.

Every route lives under `/api` and speaks JSON. `GET /api/release`, `POST /api/login/device` and `POST /api/login/device/token` are unauthenticated. Every other route needs `Authorization: Bearer <token>`; a missing or invalid token is a 401 with `{ ok: false, error }`. A refusal is always `{ ok: false, error }`, plus a `code` and the number a client needs on the ones it branches on. A 429 also carries a `Retry-After` header with the same seconds as `retryAfterSeconds`.

## auth

### `GET /api/me`

Who the bearer acts as: the user, company, role and machine.

Responses:

- `200` [Identity](#identity)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/logout`

Revoke the bearer itself. A concurrent revocation is reported as `alreadyRevoked`.

Responses:

- `200` [LoggedOut](#loggedout)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/login/device`

Begin a device login without a bearer token. Relay `verificationUrl` and `userCode` to the person, who confirms the code in their signed-in browser; the code is never typed. The login expires after ten minutes. Starts are limited per source address (`PATCHY_DEVICE_LOGIN_RATE_LIMIT_PER_MINUTE`, default 5). On a re-login, send the stored machine token's id as `previousMachineTokenId`; the old key stays live until the completing poll replaces it, and only when it belongs to the confirming user. The JSON body is limited to 4096 bytes: a declared overflow answers 413; overflow while streaming aborts the connection before parsing.

Request body: [StartDeviceLoginRequest](#startdeviceloginrequest)

Responses:

- `201` [DeviceLoginStarted](#deviceloginstarted)
- `400` { ok: false, error: string }
- `413` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/login/device/token`

Poll without a bearer token, at the returned interval. A poll made too soon answers `slow_down`; add five seconds to the interval. After browser confirmation, one poll mints the machine token and returns `complete`, including the confirming user's email and company handle and name in the same response. The key expires in 90 days or after 30 idle days. Complete, expired and denied logins are deleted, so a subsequent poll answers 410 `unknown`. Plaintext tokens are never stored. The JSON body is limited to 4096 bytes: a declared overflow answers 413; overflow while streaming aborts the connection before parsing.

Request body: [PollDeviceLoginRequest](#polldeviceloginrequest)

Responses:

- `200` [DeviceLoginWaiting](#deviceloginwaiting) | [DeviceLoginComplete](#devicelogincomplete)
- `400` { ok: false, error: string }
- `410` { ok: false, error: string, code: "expired" | "denied" | "unknown" }
- `413` { ok: false, error: string }

## patches

### `POST /api/publish`

Publish one HTML bundle and its manifest. Without `patchId` creates a patch (201); with an owned `patchId` publishes a version (200). Authenticate, then replay by owner and `publishKey` before limits or release validation: identical payloads return the stored response and status, even after an upgrade; changed payloads answer 409 `publish_key_conflict`. New attempts require the exact current release and manifest version from `GET /api/release`. Only tier 0 with empty tables, files and uses is served yet; higher tiers answer `tier_mismatch`, resources `invalid_manifest`. Tier 0 HTML passes the safe-HTML policy. Creates spend the per-token create limit and live-patch quota; updates do not. Omitted scope defaults to company on creates and remains unchanged on updates. The JSON body cap is three times the HTML cap.

Request body: [PublishRequest](#publishrequest)

Responses:

- `200` [PublishUpdated](#publishupdated)
- `201` [PublishCreated](#publishcreated)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "live_patch_quota_exceeded", quota: integer }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "publish_key_conflict" } | { ok: false, error: string }
- `413` { ok: false, error: string }
- `422` { ok: false, errors: string[], warnings: string[] } | { ok: false, error: string, code: "release_mismatch" | "invalid_manifest" | "tier_mismatch" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/share`

Change the sharing scope of a patch owned by the bearer token's user, without publishing a version. `company` requires a company member's browser session; `public` lets anyone with the link open the current version. Only the current version of a public patch is public; older versions stay behind the company door. A patch the caller does not own answers 404. The current public version may be cached for 60 seconds at both `/d/<id>` and `/d/<id>/v/<current n>`; older versions and company patches are `private, no-store` and answer 401 without a session. The JSON body is bounded by the publish body limit: three times `PATCHY_MAX_HTML_BYTES`. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged.

Request body: [ShareRequest](#sharerequest)

Responses:

- `200` [Shared](#shared)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `413` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `DELETE /api/patches/:patchId`

Delete a patch owned by the bearer token's user. The origin stops serving it at once; the expiry sweep removes its content after its retention clock expires.

Responses:

- `200` [Ok](#ok)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

## release

### `GET /api/release`

The current tooling release and its manifest and wire versions. Unauthenticated. The immutable package URL is reserved for the SDK distribution ticket; integrity is null until a real package artifact is available.

Responses:

- `200` [Release](#release)

## Shapes

### Identity

```
{
  user: {
    id: string,
    email: string,
    name: string
  },
  company: {
    id: string,
    handle: string,
    name: string
  },
  role: "member" | "admin",
  machine: {
    id: string,
    name: string
  }
}
```

### LoggedOut

```
{
  ok: true,
  alreadyRevoked: boolean
}
```

### StartDeviceLoginRequest

```
{
  machineNameHint: string,
  previousMachineTokenId?: string
}
```

### DeviceLoginStarted

```
{
  ok: true,
  deviceCode: string,
  userCode: string,
  verificationUrl: string,
  verificationUrlBare: string,
  interval: 5,
  expiresAt: string
}
```

### PollDeviceLoginRequest

```
{
  deviceCode: string
}
```

### DeviceLoginWaiting

```
{
  ok: true,
  status: "pending" | "slow_down"
}
```

### DeviceLoginComplete

```
{
  ok: true,
  status: "complete",
  token: string,
  machine: {
    id: string,
    name: string
  },
  company: {
    handle: string,
    name: string
  },
  user: {
    email: string
  },
  expiresAt: string
}
```

### PublishMetadata

```
{
  repoOrg?: string | null,
  repoName?: string | null,
  gitBranch?: string | null,
  gitCommitSha?: string | null,
  cliVersion?: string | null,
  fileSha256?: string | null
}
```

### PublishRequest

```
{
  manifest: {
    manifestVersion: integer,
    release: string,
    name?: string,
    tier: 0 | 1 | 2 | 3,
    tables: { [key: string]: { columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } },
    files: { [key: string]: {} },
    uses: { [key: string]: { kind: "postgres", handle: string, id: string, revision: integer } | { kind: "sharedTable", patchId: string, table: string, id: string, revision: integer } }
  },
  html: string,
  patchId?: string,
  scope?: "company" | "public",
  publishKey: string,
  metadata: PublishMetadata
}
```

### PublishCreated

```
{
  ok: true,
  patchId: string,
  versionId: string,
  versionNumber: integer,
  title: string,
  publicUrl: string,
  scope: "company" | "public",
  tier: integer,
  schemaRevision: integer,
  provisioned: {
    tables: string[],
    columns: string[],
    indexes: string[],
    stores: string[]
  },
  unused: {
    tables: string[],
    columns: string[],
    indexes: string[],
    stores: string[]
  },
  warnings: string[]
}
```

### PublishUpdated

```
{
  ok: true,
  patchId: string,
  versionId: string,
  versionNumber: integer,
  title: string,
  publicUrl: string,
  scope: "company" | "public",
  tier: integer,
  schemaRevision: integer,
  provisioned: {
    tables: string[],
    columns: string[],
    indexes: string[],
    stores: string[]
  },
  unused: {
    tables: string[],
    columns: string[],
    indexes: string[],
    stores: string[]
  },
  warnings: string[]
}
```

### ShareRequest

```
{
  scope: "company" | "public"
}
```

### Shared

```
{
  ok: true,
  patchId: string,
  scope: "company" | "public",
  publicUrl: string
}
```

### Ok

```
{
  ok: true
}
```

### Release

```
{
  release: string,
  package: {
    tarball: string,
    integrity: string | null
  },
  manifestVersion: integer,
  wireVersion: integer
}
```
