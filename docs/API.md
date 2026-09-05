# Patchy Cloud API

Rendered from `PatchyApi` in `packages/api` by `pnpm --filter @patchy/api render-docs`. Do not
edit by hand: a test fails when this file and the schemas disagree.

Every route lives under `/api` and speaks JSON. Only `POST /api/login/device` and `POST /api/login/device/token` are unauthenticated. Every other route needs `Authorization: Bearer <token>`; a missing or invalid token is a 401 with `{ ok: false, error }`. A refusal is always `{ ok: false, error }`, plus a `code` and the number a client needs on the ones it branches on. A 429 also carries a `Retry-After` header with the same seconds as `retryAfterSeconds`.

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

Begin a device login without a bearer token. Relay `verificationUrl` and `userCode` to the person, who confirms the code in their signed-in browser; the code is never typed. The login expires after ten minutes. Starts are limited per source address (`PATCHY_DEVICE_LOGIN_RATE_LIMIT_PER_MINUTE`, default 5). On a re-login, send the stored machine token's id as `previousMachineTokenId`; the old key stays live until the completing poll replaces it, and only when it belongs to the confirming user.

Request body: [StartDeviceLoginRequest](#startdeviceloginrequest)

Responses:

- `201` [DeviceLoginStarted](#deviceloginstarted)
- `400` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/login/device/token`

Poll without a bearer token, at the returned interval. A poll made too soon answers `slow_down`; add five seconds to the interval. After browser confirmation, one poll mints the machine token and returns `complete`. The key expires in 90 days or after 30 idle days. Complete, expired and denied logins are deleted, so a subsequent poll answers 410 `unknown`. Plaintext tokens are never stored.

Request body: [PollDeviceLoginRequest](#polldeviceloginrequest)

Responses:

- `200` { ok: true, status: "pending" | "slow_down" } | { ok: true, status: "complete", token: string, machine: { id: string, name: string }, expiresAt: string }
- `400` { ok: false, error: string }
- `410` { ok: false, error: string, code: "expired" | "denied" | "unknown" }

## patches

### `POST /api/uploads`

Publish a document for the bearer token's user. With no `patchId` it creates a patch and answers 201; with one it adds a version to that user's patch and answers 200. The HTML is checked against the safe-HTML policy first, and a 422 lists what failed. A create also debits per-token create limit and counts against the user's live-patch quota; an update costs nothing against either. Optional `scope` is `company` or `public`: omitted on a create it defaults to `company`; omitted on an update it stays unchanged. An explicit scope sets it either way.

Request body: [UploadRequest](#uploadrequest)

Responses:

- `200` [UploadUpdated](#uploadupdated)
- `201` [UploadCreated](#uploadcreated)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "live_patch_quota_exceeded", quota: integer }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string }
- `413` { ok: false, error: string }
- `422` { ok: false, errors: string[], warnings: string[] }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/share`

Change the sharing scope of a patch owned by the bearer token's user, without publishing a version. `company` requires a company member's browser session; `public` lets anyone with the link open it. A patch the caller does not own answers 404. Both latest and version URLs follow the scope: public responses may be cached for 60 seconds; company responses are private and never stored. The JSON body is bounded by the upload body limit: 2 MiB by default, or three times `PATCHY_MAX_HTML_BYTES` when that is larger. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged.

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

Delete a patch owned by the bearer token's user. The patch stops serving at once and its content goes with the next expiry sweep.

Responses:

- `200` [Ok](#ok)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

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

### UploadMetadata

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

### UploadRequest

```
{
  html: string,
  filename?: string | null,
  patchId?: string | null,
  scope?: "company" | "public",
  metadata?: UploadMetadata
}
```

### UploadCreated

```
{
  ok: true,
  patchId: string,
  versionId: string,
  versionNumber: integer,
  title: string,
  publicUrl: string,
  scope: "company" | "public",
  warnings: string[]
}
```

### UploadUpdated

```
{
  ok: true,
  patchId: string,
  versionId: string,
  versionNumber: integer,
  title: string,
  publicUrl: string,
  scope: "company" | "public",
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
