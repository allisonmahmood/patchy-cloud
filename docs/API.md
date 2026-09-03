# Patchy Cloud API

Rendered from `PatchyApi` in `packages/api` by `pnpm --filter @patchy/api render-docs`. Do not
edit by hand: a test fails when this file and the schemas disagree.

Every route lives under `/api` and speaks JSON. Every route but the self-service mint needs `Authorization: Bearer <token>`; a missing or invalid token is a 401 with `{ ok: false, error }`. A refusal is always `{ ok: false, error }`, plus a `code` and the number a client needs on the ones it branches on. A 429 also carries a `Retry-After` header with the same seconds as `retryAfterSeconds`.

## auth

### `POST /api/tokens/self-service`

Mint a self-service token. Takes no input: an absent body and `{}` are both accepted. The only route that admits a request with no credential — it is how a caller gets its first token — so the instance's enabled flag, a per-address rate limit and a per-address daily quota stand in for authentication. The plaintext token appears in this response and nowhere else.

Responses:

- `201` [MintedToken](#mintedtoken)
- `400` { ok: false, error: string }
- `403` { ok: false, error: string, code: "self_service_disabled" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer } | { ok: false, error: string, code: "mint_quota_exceeded", quota: integer }

### `POST /api/login/device`

PROTOTYPE (#131). Start a device login: answers the device code the CLI polls with, the eight-character user code the person confirms, the confirm page's URL with and without that code, the poll interval and the expiry (ten minutes). Unauthenticated; per-address rate limited.

Request body: [DeviceLoginStartRequest](#deviceloginstartrequest)

Responses:

- `201` [DeviceLoginStarted](#deviceloginstarted)
- `400` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/login/device/token`

PROTOTYPE (#131). Poll a device login by its device code. `pending` until the person answers (`slow_down` when polled faster than the interval); `complete` carries the machine token exactly once and deletes the login. A 410 says why there will never be a token: `expired`, `denied`, or `unknown` — a code that was already reported is unknown.

Request body: [DeviceLoginPollRequest](#deviceloginpollrequest)

Responses:

- `200` [DeviceLoginPending](#deviceloginpending) | [DeviceLoginComplete](#devicelogincomplete)
- `400` { ok: false, error: string }
- `410` { ok: false, error: string, code: "expired" | "denied" | "unknown" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `GET /api/me`

Who the bearer token is: its principal, its own id and name, and its scopes.

Responses:

- `200` [Identity](#identity)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/tokens`

Issue a token for the caller's own principal. Admin scope. `scopes` defaults to `["upload"]` and `name` to `CLI API Token`. The plaintext token appears in this response and nowhere else.

Request body: [CreateTokenRequest](#createtokenrequest)

Responses:

- `201` [CreatedToken](#createdtoken)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/tokens/:apiTokenId/revoke`

Permanently revoke a token. Admin scope. Revoked is a state, never a deletion: the token's patches stay up until they expire, with their retention top-ups frozen. Idempotent — revoking twice answers the same, with the original `revokedAt` intact.

Responses:

- `200` [RevokedToken](#revokedtoken)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

## patches

### `POST /api/uploads`

Publish a document. Upload scope. With no `patchId` it creates a patch and answers 201; with one it adds a version to that patch and answers 200. The HTML is checked against the safe-HTML policy first, and a 422 lists what failed. A create also debits the per-token create limit and counts against the live-patch quota; an update costs nothing against either.

Request body: [UploadRequest](#uploadrequest)

Responses:

- `200` [UploadUpdated](#uploadupdated)
- `201` [UploadCreated](#uploadcreated)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "live_patch_quota_exceeded", quota: integer } | { ok: false, error: string }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string }
- `413` { ok: false, error: string }
- `422` { ok: false, errors: string[], warnings: string[] }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `GET /api/patches/:patchId`

A patch as the moderation surface sees it: the principal behind it and the token that created it. Admin scope. Answers for disabled, deleted and expired patches too.

Responses:

- `200` [PatchView](#patchview)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `DELETE /api/patches/:patchId`

Delete a patch. Its creator may delete it; admin scope reaches any principal's. The patch stops serving at once and its content goes with the next expiry sweep.

Responses:

- `200` [Ok](#ok)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `GET /api/principals/:principalId/patches`

Everything a principal holds, newest first, deleted patches omitted, at most 200 — `truncated` says there is more. Admin scope.

Responses:

- `200` [PrincipalPatches](#principalpatches)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/disable`

Take a patch out of service. Its creator may disable it; admin scope reaches any principal's. A disabled patch stops serving at once and keeps its row until the expiry sweep takes it.

Request body: [DisableRequest](#disablerequest)

Responses:

- `200` [Ok](#ok)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/pin`

Exempt a patch from expiry. Admin scope, any principal's patch. Only a patch in service can be pinned: a deleted or disabled one is a 404.

Responses:

- `200` [Pinned](#pinned)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/unpin`

Hand a pinned patch back to its retention clock, at whatever time it has left. Admin scope. Works on anything still there.

Responses:

- `200` [Pinned](#pinned)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

## Shapes

### MintedToken

```
{
  ok: true,
  token: string
}
```

### DeviceLoginStartRequest

```
{
  machineName?: string | null,
  previousTokenId?: string | null
}
```

### DeviceLoginStarted

```
{
  ok: true,
  deviceCode: string,
  userCode: string,
  verificationUrl: string,
  verificationUrlComplete: string,
  expiresAt: string (ISO-8601),
  interval: integer
}
```

### DeviceLoginPollRequest

```
{
  deviceCode: string
}
```

### DeviceLoginPending

```
{
  ok: true,
  status: "pending" | "slow_down",
  expiresAt: string (ISO-8601)
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
  accountId: string,
  accountName: string
}
```

### Identity

```
{
  accountId: string,
  accountName: string,
  apiTokenId: string,
  apiTokenName: string,
  scopes: string[]
}
```

### CreateTokenRequest

```
{
  name?: string | null,
  scopes?: string[]
}
```

### CreatedToken

```
{
  ok: true,
  apiToken: {
    id: string,
    name: string
  },
  token: string
}
```

### RevokedToken

```
{
  ok: true,
  alreadyRevoked: boolean,
  apiToken: {
    id: string,
    name: string,
    principalId: string,
    revokedAt: string (ISO-8601)
  }
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
  warnings: string[]
}
```

### ModeratedPatch

```
{
  id: string,
  principalId: string,
  createdByApiTokenId: string | null,
  title: string,
  createdAt: string (ISO-8601),
  updatedAt: string (ISO-8601),
  expiresAt: string (ISO-8601),
  pinnedAt: string (ISO-8601) | null,
  deletedAt: string (ISO-8601) | null,
  disabledAt: string (ISO-8601) | null,
  disabledReason: string | null
}
```

### PatchView

```
{
  ok: true,
  patch: ModeratedPatch
}
```

### PrincipalPatches

```
{
  ok: true,
  principalId: string,
  patches: ModeratedPatch[],
  truncated: boolean
}
```

### DisableRequest

```
{
  reason?: string | null
}
```

### Ok

```
{
  ok: true
}
```

### Pinned

```
{
  ok: true,
  pinned: boolean
}
```
