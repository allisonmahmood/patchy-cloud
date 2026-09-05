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

### `GET /api/me`

Who the bearer token is: its principal, its own id and name, and its scopes.

Responses:

- `200` [Identity](#identity)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

## patches

### `POST /api/uploads`

Publish a document for the bearer token's principal. With no `patchId` it creates a patch and answers 201; with one it adds a version to that principal's patch and answers 200. The HTML is checked against the safe-HTML policy first, and a 422 lists what failed. A create also debits the per-token create limit and counts against the live-patch quota; an update costs nothing against either.

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

### `DELETE /api/patches/:patchId`

Delete a patch owned by the bearer token's principal. The patch stops serving at once and its content goes with the next expiry sweep.

Responses:

- `200` [Ok](#ok)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
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

### Ok

```
{
  ok: true
}
```
