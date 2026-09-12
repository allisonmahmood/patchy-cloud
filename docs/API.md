# Patchy Cloud API

Rendered from `PatchyApi` in `packages/api` by `pnpm --filter @patchy/api render-docs`. Do not
edit by hand: a test fails when this file and the schemas disagree.

Every route lives under `/api`. Most speak JSON; runtime file routes carry raw bytes. `GET /api/release`, `POST /api/login/device` and `POST /api/login/device/token` are unauthenticated. `/api/runtime/*` admits only the shell's browser requests with the runtime headers and loaded-version admission described below; machine tokens are refused. Other routes need `Authorization: Bearer <token>`; a missing or invalid token is a 401 with `{ ok: false, error }`. Refusals add `code` and operation-specific fields when clients branch on them. A 429 carries `Retry-After` seconds; bearer API rate-limit responses also carry `retryAfterSeconds`.

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

Publish one HTML bundle and its manifest. Without `patchId` creates a patch (201); with an owned `patchId` publishes a version (200). Authenticate, then replay by owner and `publishKey` before limits or release validation: identical payloads return the stored response and status, even after an upgrade; changed payloads answer 409 `publish_key_conflict`. New attempts require the exact current release and manifest version from `GET /api/release`. Tier 0 may define tables, provisioned additively; higher tiers answer `tier_mismatch`, files and uses `invalid_manifest`. Schema changes are checked before bytes and rechecked under the patch lock. Preflight conservatively refuses new indexes with existing uncompressed key tuples over 2,000 bytes, and added columns that expand existing rows over the row limit. `not_additive` names every refused object, change and fix. Omitted tables remain in the cumulative inventory and appear as `unused`; a required column cannot be omitted. The schema revision advances only when provisioning changes something, never for a new bundle alone. File mode (empty definitions and no repo name, or file metadata) onto cumulative inventory answers `has_primitives`; an empty named repo manifest may omit all tables. Reports and schema revision are persisted for replay. Tier 0 HTML passes the safe-HTML policy. Creates spend the per-token create limit and live-patch quota; updates do not. Omitted scope defaults to company on creates and remains unchanged on updates. `manifest.name` is an exact company-scoped name (3–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit); a taken current name answers 409 `name_taken` on create or rename. Without a name, creates derive one from `metadata.filename` without its extension (title when absent), normalize it, fall back to `patch` and add `-2`, `-3`, etc. on collision. Updates with no name retain their existing name. Rename leaves a redirect until another patch claims it; deletion frees all names. `address` and `publicUrl` both name the absolute `/<company>/<name>` address. The JSON body cap is three times the HTML cap.

Request body: [PublishRequest](#publishrequest)

Responses:

- `200` [PublishUpdated](#publishupdated)
- `201` [PublishCreated](#publishcreated)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "live_patch_quota_exceeded", quota: integer }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "publish_key_conflict" } | { ok: false, error: string, code: "name_taken" } | { ok: false, error: string }
- `413` { ok: false, error: string }
- `422` { ok: false, errors: string[], warnings: string[] } | { ok: false, error: string, code: "not_additive", changes: { object: string, change: string, fix: string }[] } | { ok: false, error: string, code: "release_mismatch" | "invalid_manifest" | "tier_mismatch" | "has_primitives" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "busy" | "source_unavailable" }

### `GET /api/patches/:patchId/inventory`

Read the cumulative table and file-store definitions and schema revision for an owned, available patch. Omitted definitions remain here. Unknown, unavailable and another user's patches all answer 404. A primitive-free patch answers empty definitions and revision zero. An existing ready company database is probed for inventory even when the current version declares none: a failed platform commit may have left cumulative definitions. An unavailable database answers `source_unavailable` (or `busy`), never a fabricated empty inventory.

Responses:

- `200` [PatchInventory](#patchinventory)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "busy" | "source_unavailable" }

### `POST /api/patches/:patchId/share`

Change the sharing scope of a patch owned by the bearer token's user, without publishing a version. `company` requires a company member's browser session; `public` lets anyone with the link open the current version. Only the current version of a public patch is public; older versions stay behind the company door. A patch the caller does not own answers 404. The current public version may be cached for 60 seconds at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>`; older versions and company patches are `private, no-store` and answer 401 without a session. The JSON body is bounded by the publish body limit: three times `PATCHY_MAX_HTML_BYTES`. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged.

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

Delete a patch owned by the bearer token's user. The origin stops serving it at once; all its names are freed, and the expiry sweep removes its content after its retention clock expires.

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

## runtime

### `POST /api/runtime/call`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null and every other operation, including unknown ones, with `not_available_on_public`, with or without a session and before any principal check. Public shells always send a null principal. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); only `me` may bootstrap with null. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by default; `rate_limited` is 429 with `Retry-After` seconds. Responses, including failures, are `Cache-Control: no-store`. The JSON envelope is `{ patchId, versionId, principal, wire, op, args }`; its principal and wire must match the required headers. Mutating operations additionally require the exact shell `Origin` (scheme, host and port); a cross-site or missing Origin is refused before execution. `me` with `args: {}` returns `{ ok: true, value: { user: { id, name, email }, company: { id, handle, name }, admin } }` on company versions, or `{ ok: true, value: null }` on public versions; `admin` is a UI hint, not additional authority. The seven `tables.*` operations resolve tables and validate rows against the loaded version's manifest, not the newest version. `get` returns a row or null; `getMany` preserves input order and nulls; `insert`, `insertMany` and `update` return their rows; `delete` returns null, including for a missing row. `update` of a missing row is `row_not_found`. Defaults apply to omitted insert fields, optional fields accept null, and explicit null for a defaulted field is `invalid_row`. `list { table, index?, eq?, range?, order?, limit?, cursor? }` returns `{ rows, cursor }`. The default index is `(createdAt, id)`; `eq` constrains leading index columns, one `range { column, gt?, gte?, lt?, lte? }` constrains the next column, and `order` is `asc` or `desc` with an id tie-breaker. Keyset cursors are bound to table, index, filters and order. The page defaults to 100 rows and is capped at 1,000; `getMany` and `insertMany` are capped at 1,000 items and 8 MiB, individual rows at 1 MiB. List and getMany results are capped at 8 MiB, checking database JSON transport before decoding and final wire bytes afterward. Transport whitespace can make its check stricter. Native PostgreSQL B-tree key-size failures are `too_large`; publishing a non-unique index adds no separate size CHECK constraint or 2,000-byte runtime write limit. Request bodies allow 1 MiB plus envelope for insert/update and 8 MiB plus envelope for insertMany; all other calls are capped at 64 KiB. Overflow is `too_large` (413). Undeclared tables answer `table_not_declared`; invalid fields/defaults answer `invalid_row`, uniqueness conflicts `unique_violation`, and invalid pagination `invalid_cursor`. Unknown operations answer `invalid_request`. Failures are `{ ok: false, error, code, correlationId? }`; every table mutation is logged before execution and logged failures carry their runtime-log correlation id. Table reads are not logged. Files and other unimplemented operation names remain refused.

Request body: [RuntimeCall](#runtimecall)

Responses:

- `200` [RuntimeSuccess](#runtimesuccess)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `409` [RuntimeFailure_3](#runtimefailure_3)
- `413` [RuntimeFailure_4](#runtimefailure_4)
- `429` [RuntimeFailure_5](#runtimefailure_5)
- `503` [RuntimeFailure_6](#runtimefailure_6)

### `GET /api/runtime/files/:patchId/:versionId/:store/*`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null and every other operation, including unknown ones, with `not_available_on_public`, with or without a session and before any principal check. Public shells always send a null principal. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); only `me` may bootstrap with null. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by default; `rate_limited` is 429 with `Retry-After` seconds. Responses, including failures, are `Cache-Control: no-store`. GET additionally requires the exact browser header `Sec-Fetch-Site: same-origin`. Principal and wire travel only in their required headers; GET has no request body. The trailing `*` is the file name, not an object URL. Encode the full name with `encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. The wildcard also accepts slash-separated segments and avoids the router's 100-character named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; `store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or base64; the byte limit is 20 MiB. These file routes are reserved: after the same admission they currently answer `invalid_request` on company versions or `not_available_on_public` on public versions, never a fake success. The byte response carries the stored `Content-Type` and `no-store`, never a redirect to uploaded content. HTML and SVG remain bytes, never a navigable page.

Responses:

- `200` raw bytes (`application/octet-stream`)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `409` [RuntimeFailure_3](#runtimefailure_3)
- `413` [RuntimeFailure_4](#runtimefailure_4)
- `429` [RuntimeFailure_5](#runtimefailure_5)
- `503` [RuntimeFailure_6](#runtimefailure_6)

### `PUT /api/runtime/files/:patchId/:versionId/:store/*`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null and every other operation, including unknown ones, with `not_available_on_public`, with or without a session and before any principal check. Public shells always send a null principal. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); only `me` may bootstrap with null. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by default; `rate_limited` is 429 with `Retry-After` seconds. Responses, including failures, are `Cache-Control: no-store`. PUT additionally requires the exact shell `Origin` (scheme, host and port). The uploaded media type travels as `Content-Type`. Principal and wire travel only in their required headers; the body contains only raw file bytes. The trailing `*` is the file name, not an object URL. Encode the full name with `encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. The wildcard also accepts slash-separated segments and avoids the router's 100-character named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; `store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or base64; the byte limit is 20 MiB. These file routes are reserved: after the same admission they currently answer `invalid_request` on company versions or `not_available_on_public` on public versions, never a fake success. The declared byte response contract uses `application/octet-stream` as its default, with the actual media type supplied by the handler.

Request body: raw bytes (`application/octet-stream`)

Responses:

- `200` raw bytes (`application/octet-stream`)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `409` [RuntimeFailure_3](#runtimefailure_3)
- `413` [RuntimeFailure_4](#runtimefailure_4)
- `429` [RuntimeFailure_5](#runtimefailure_5)
- `503` [RuntimeFailure_6](#runtimefailure_6)

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
  filename?: string | null,
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
    tables: { [key: string]: { columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } },
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
  name: string,
  address: string,
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
  name: string,
  address: string,
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

### PatchInventory

```
{
  schemaRevision: integer,
  tables: { [key: string]: { columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } },
  files: { [key: string]: {} }
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

### RuntimePrincipal

```
{ userId: string } | null
```

### RuntimeCall

```
{ patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "me", args: {} } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.get", args: { table: string, id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.getMany", args: { table: string, ids: string[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.list", args: { table: string, index?: string, eq?: { [key: string]: unknown }, range?: { column: string, gt?: unknown, gte?: unknown, lt?: unknown, lte?: unknown }, order?: "asc" | "desc", limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.insert", args: { table: string, row: { [key: string]: unknown } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.insertMany", args: { table: string, rows: { [key: string]: unknown }[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.update", args: { table: string, id: string, patch: { [key: string]: unknown } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.delete", args: { table: string, id: string } }
```

### RuntimeMe

```
{ user: { id: string, email: string, name: string }, company: { id: string, handle: string, name: string }, admin: boolean } | null
```

### RuntimeSuccess

```
{
  ok: true,
  value: RuntimeMe | { [key: string]: unknown } | null | { [key: string]: unknown } | null[] | { rows: { [key: string]: unknown }[], cursor: string | null } | { [key: string]: unknown }[] | { [key: string]: unknown } | null
}
```

### RuntimeCode

```
"table_not_declared" | "row_not_found" | "invalid_row" | "unique_violation" | "access_denied" | "invalid_cursor" | "not_additive" | "connection_not_declared" | "invalid_request" | "timeout" | "too_large" | "source_unavailable" | "relation_unknown" | "invalid_query" | "shape_mismatch" | "session_expired" | "principal_changed" | "not_available_on_public" | "shell_outdated" | "unknown_outcome" | "rate_limited" | "too_many_requests" | "busy" | "offset_exhausted"
```

### RuntimeFailure

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  correlationId?: string
}
```

### RuntimeFailure_1

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  correlationId?: string
}
```

### RuntimeFailure_2

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  correlationId?: string
}
```

### RuntimeFailure_3

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  correlationId?: string
}
```

### RuntimeFailure_4

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  correlationId?: string
}
```

### RuntimeFailure_5

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  correlationId?: string
}
```

### RuntimeFailure_6

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  correlationId?: string
}
```
