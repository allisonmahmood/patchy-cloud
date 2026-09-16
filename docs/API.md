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

Publish one HTML bundle and its manifest. Without `patchId` creates a patch (201); with an owned live `patchId` publishes a version (200). Authenticate, then replay by owner and `publishKey` before limits or release validation: identical payloads return the stored response and status, even after an upgrade; changed payloads answer 409 `publish_key_conflict`. New attempts require the exact current release and manifest version from `GET /api/release`. Tiers 0 and 1 may define tables and file stores, provisioned additively; tiers 2 and above answer `tier_mismatch`. Every table and file store requires a nonblank description; missing or blank descriptions and table/store name collisions answer `invalid_manifest`. Postgres uses carry `{ kind: "postgres", handle, id, revision }`, keyed by alias. The handle and id must name the same connected company connection, otherwise `connection_not_connected`; the revision must equal its current schema snapshot, otherwise `stale_generated` (run `patchy refresh`). Credential rotation and retargeting preserve the connection id. Postgres runtime calls retain the version's recorded snapshot. Shared-table uses carry `{ kind: "sharedTable", patchId, table, id, revision }`, keyed by alias. The resolved id is `<patchId>/<table>`, never a patch name; revision stamps the source inventory. Publish requires a live same-company source the publisher can open and an inventory table marked shared, otherwise `patch_not_openable`. A stamp behind the source revision warns, not refuses. Unsharing a defined table refuses with `has_dependants` and the distinct live declaring patches, including declarations in retained versions, unless `force` is true. Ask the person you are working for before forcing. Omission and rollback never change sharing. Ownership and lifecycle are checked before validating HTML and again at commit: another company's patch is 404; a same-company non-owner gets `not_owner` first, with the current owner. The owner gets `patch_retired` or `patch_deleted` with `purgeAt`, and must restore before publishing. Schema changes are checked before storage and rechecked under the patch lock. Preflight conservatively refuses new indexes with existing uncompressed key tuples over 2,000 bytes, and added columns that expand existing rows over the row limit. `not_additive` names every refused object, change and fix. Omitted tables and stores remain in the cumulative inventory with their data and appear as `unused`; a required column cannot be omitted. A publish replaces descriptions of the primitives it defines; omission and rollback preserve them. Description-only changes do not advance the schema revision. The revision advances for schema or sharing changes, never for a new bundle alone. File mode (empty definitions and no repo name, or file metadata) onto cumulative inventory answers `has_primitives`; an empty named repo manifest may omit all tables. Reports and schema revision are persisted for replay. Tier 0 HTML passes the safe-HTML policy; executable or otherwise unsafe content answers `tier_mismatch`. Empty or oversized tier 0 documents retain the HTML validation refusal. Tier 1 bundles are stored raw, without safe-HTML validation or transformation. Tier 0 keeps `PATCHY_MAX_HTML_BYTES` (512 KiB); tier 1 uses `PATCHY_MAX_BUNDLE_BYTES` (10 MiB), with oversized bundles refused as 413. Creates spend the per-token create limit and live-patch quota; updates do not. Omitted scope defaults to company on creates and remains unchanged on updates. `manifest.name` is an exact company-scoped name (3–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit); a taken current name answers 409 `name_taken` on create or rename, including deleted patches. `patches` and `connections` are reserved names and answer 422 `reserved_name` on create. Without a name, creates derive one from `metadata.filename` without its extension (title when absent), normalize it, fall back to `patch` and add `-2`, `-3`, etc. on collision. Updates with no name retain their existing name. Rename leaves a redirect until another patch claims it; retire and delete reserve names until the deletion sweep reclaims the patch after 30 days. `manifest.description` or file mode's `metadata.description` updates the description; omitted, the cloud text remains. Descriptions collapse whitespace, permit at most 500 Unicode code points and no control characters, and are returned with `descriptionUpdatedAt`. `address` and `publicUrl` both name the absolute `/<company>/<name>` address. The JSON body cap is three times the larger configured HTML or bundle cap.

Request body: [PublishRequest](#publishrequest)

Responses:

- `200` [PublishUpdated](#publishupdated)
- `201` [PublishCreated](#publishcreated)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "live_patch_quota_exceeded", quota: integer } | { ok: false, error: string, code: "not_owner", owner: { id: string, name: string } }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "publish_key_conflict" } | { ok: false, error: string, code: "name_taken" } | { ok: false, error: string, code: "patch_retired" } | { ok: false, error: string, code: "patch_deleted", purgeAt: string } | { ok: false, error: string, code: "has_dependants", dependants: { patchId: string, name: string, owner: { id: string, name: string } }[] } | { ok: false, error: string }
- `413` { ok: false, error: string }
- `422` { ok: false, errors: string[], warnings: string[] } | { ok: false, error: string, code: "reserved_name" } | { ok: false, error: string, code: "invalid_description" } | { ok: false, error: string, code: "not_additive", changes: { object: string, change: string, fix: string }[] } | { ok: false, error: string, code: "release_mismatch" | "invalid_manifest" | "tier_mismatch" | "has_primitives" | "patch_not_openable" | "connection_not_connected" | "stale_generated" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "busy" | "source_unavailable" }

### `GET /api/patches`

List the bearer credential's openable company patches, including public patches but never another company's. Machine tokens only; browser sessions do not grant API access. `state` is live by default, retired for retired patches, or all for live, retired and deleted patches not yet reclaimed. The recovery deadline limits restore; the deletion sweep makes a patch gone. A bare `?mine` or `mine=true` restricts the list to the token's owner; `mine=false` does not. Results are yours first, then the company's, sorted by name within each group. Each row includes the canonical id, address, owner and deactivated mark, description, lifecycle stamps, current version, tier and publish time. `purgeAt` is 30 days after deletion. Unopenable, disabled and gone patches are absent. No connections, table names or business rows are returned. Responses are private, no-store.

Responses:

- `200` { patches: [PatchSummary](#patchsummary)[] }
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `GET /api/patches/:patchRef`

Read one openable company patch by canonical id or exact name, using the same state filter as the list. Names resolve only non-deleted patches; ids resolve any retained state. A resolved patch outside the requested state answers 409 `wrong_state` with its actual state. Unknown, unopenable, disabled, foreign, gone and deleted-by-name references answer the same 404. The summary gains `title`, a cumulative `inventory: { tables, stores } | null`, and `reads` across every retained version, including declarations dropped by the current version. Existing in-company sources retain their lifecycle state even when disabled or unopenable; only openable sources expose a name. Source state does not imply permission to read it. Sources absent from the company lookup are `gone` without a name; foreign metadata is never queried. An unavailable company database means null inventory, never fabricated empty arrays. Live shared tables are declarable and carry `patchy add shared-table <patchId>/<table>`; unshared tables carry `not_shared` and an owner-name hint. Off tables carry `source_off`; stores carry `not_shareable`. No versions, dependants or business rows are returned. Machine tokens only. Overlong references answer 414. Responses are private, no-store.

Responses:

- `200` [PatchDetail](#patchdetail)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `GET /api/patches/:patchRef/primitives/:name`

Read one table or file store from a patch's cumulative inventory with the detail route's id-or-name resolution, openability gate and state filter. Returns kind, name, description, sharing, schema revision, columns and indexes, never rows or contents. Columns report their name, kind, optional flag, an optional ref target and a default only when present; an explicit null default stays present. Indexes report name, columns and uniqueness. Stores have `kind: store`, `shared: false` and empty columns and indexes. A missing table or store answers 404; an unavailable inventory answers 503 `source_unavailable`, not a missing primitive. Machine tokens only. Overlong patch references answer 414. Responses are private, no-store.

Responses:

- `200` [PrimitiveDetail](#primitivedetail)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "busy" | "source_unavailable" }

### `GET /api/patches/:patchId/inventory`

Read the cumulative table and file-store definitions and schema revision for an openable same-company patch in any lifecycle state, including each primitive's stored description. Omitted definitions and their descriptions remain here. Unknown, disabled, gone and foreign patches answer 404. A primitive-free patch answers empty definitions and revision zero. An existing ready company database is probed for inventory even when the current version declares none: a failed platform commit may have left cumulative definitions. An unavailable database answers `source_unavailable` (or `busy`), never a fabricated empty inventory.

Responses:

- `200` [PatchInventory](#patchinventory)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "busy" | "source_unavailable" }

### `POST /api/patches/:patchId/share`

Change the sharing scope of a patch owned by the bearer token's user, without publishing a version. `company` requires a company member's browser session; `public` lets anyone with the link open the current version. Only the current version of a public patch is public; older versions stay behind the company door. A same-company non-owner answers 403 `not_owner`, including an admin's machine token; another company answers 404. Only live patches permit scope changes, otherwise `wrong_state`. The current public version may be cached for 60 seconds at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>`; older versions and company patches are `private, no-store` and answer 401 without a session. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`; the larger scripted-bundle cap applies only to publishing. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged.

Request body: [ShareRequest](#sharerequest)

Responses:

- `200` [Shared](#shared)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "not_owner", owner: { id: string, name: string } }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" }
- `413` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/retire`

Retire an owned live patch. It stops serving and its shared tables stop answering readers. Everything is retained indefinitely, including its names. Live dependants refuse with `has_dependants` unless `force` is true. Ask the person you are working for before forcing. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the patch unchanged.

Request body: [ForceRequest](#forcerequest)

Responses:

- `200` [Retired](#retired)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "not_owner", owner: { id: string, name: string } }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" } | { ok: false, error: string, code: "has_dependants", dependants: { patchId: string, name: string, owner: { id: string, name: string } }[] }
- `413` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `DELETE /api/patches/:patchId`

Delete an owned live or retired patch. It stops serving but retains its names, versions, tables and files through a fixed 30-day recovery window. `purgeAt` is the deadline; the deletion sweep reclaims it at or after that time. From live, dependants refuse with `has_dependants` unless `force` is true. Delete from retired has no dependant refusal. A bare `?force` means true.

Responses:

- `200` [Deleted](#deleted)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "not_owner", owner: { id: string, name: string } }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" } | { ok: false, error: string, code: "has_dependants", dependants: { patchId: string, name: string, owner: { id: string, name: string } }[] }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/restore`

Restore an owned retired or deleted patch to live, preserving its address and description. Recovery applies only to deletions after the lifecycle migration; legacy deleted patch IDs remain 404. Deleted patches require the current time to be before `purgeAt`, otherwise `patch_deleted`. The current version's off sources refuse with `sources_off`, listing each source's table and state, including gone, unless `force` is true. Ask the person you are working for before forcing. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the patch unchanged.

Request body: [ForceRequest](#forcerequest)

Responses:

- `200` [Restored](#restored)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "not_owner", owner: { id: string, name: string } }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" } | { ok: false, error: string, code: "sources_off", sources: { patchId: string, name?: string, table: string, state: "live" | "retired" | "deleted" | "gone" }[] } | { ok: false, error: string, code: "patch_deleted", purgeAt: string }
- `413` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/rollback`

Move an owned live patch's address to a retained `versionNumber`, creating no version. Tables, files, sharing, name and description do not change. A missing version answers 422 `version_unavailable`; an off patch answers `wrong_state`. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the patch unchanged.

Request body: [RollbackRequest](#rollbackrequest)

Responses:

- `200` [RolledBack](#rolledback)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "not_owner", owner: { id: string, name: string } }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" }
- `413` { ok: false, error: string }
- `414` { ok: false, error: string }
- `422` { ok: false, error: string, code: "version_unavailable" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `PUT /api/patches/:patchId/description`

Set an owned live or retired patch's description without publishing a version. Whitespace runs collapse to spaces and surrounding whitespace is trimmed. The result is one paragraph of at most 500 Unicode code points with no control characters; invalid text answers 422 `invalid_description`. An empty string clears it. Markup is stored literally. A no-op save does not change its timestamp. Deleted patches answer `wrong_state`. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the patch unchanged.

Request body: [DescriptionRequest](#descriptionrequest)

Responses:

- `200` [Described](#described)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `403` { ok: false, error: string, code: "not_owner", owner: { id: string, name: string } }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" }
- `413` { ok: false, error: string }
- `414` { ok: false, error: string }
- `422` { ok: false, error: string, code: "invalid_description" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

## connections

### `GET /api/connections`

List the caller's company connections, including disconnected ones, for any active member. Connected entries carry a copy-ready add hint; disconnected entries carry reason `not_connected` and a /company/connections hint. A bare all or all=true also includes every offered integration's connected state. No snapshots, credentials or business rows. Responses are private, no-store.

Responses:

- `200` { connections: { id: string, handle: string, integration: "postgres", description: string, status: "connected" | "disconnected", hint: string, reason?: "not_connected" }[], offered?: { integration: "postgres", connected: boolean }[] }
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "connection_storage_failed" }

### `GET /api/connections/:handle`

Read one company connection by its exact handle, for any active member. The current immutable snapshot includes its revision and ISO takenAt timestamp, including when the connection is disconnected. A missing snapshot is null, never an empty database. Unknown handles and another company's connections answer the same 404. Never returns credentials or business rows. Responses are private, no-store.

Responses:

- `200` { handle: string, description: string, status: "connected" | "disconnected", snapshot: { version: 1, relations: { schema: string, name: string, kind: "table" | "view", columns: { name: string, type: { schema: string, name: string, sql: string, baseSchema: string, baseName: string, kind: "base" | "enum" | "array", element?: { baseSchema: string, baseName: string, kind: "base" | "enum" } }, nullable: boolean }[], primaryKey: { name: string, columns: string[] } | null, foreignKeys: { name: string, columns: string[], target: { schema: string, relation: string, columns: string[] } }[] }[], enums: { schema: string, name: string, labels: string[] }[], exclusions: { schema: string, relation: string, column?: string, reason: "access_denied" | "relation_limit" | "column_limit" | "unsupported_type" | "reserved_name" | "key_limit" | "enum_limit" }[], revision: integer, takenAt: string } | null }
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "connection_storage_failed" }

## sdk

### `GET /api/release`

The current tooling release and its manifest and wire versions. Unauthenticated. GET /sdk/patchy-<release>.tgz serves this release's tarball without authentication with Cache-Control: public, max-age=31536000, immutable; integrity is its sha512 Subresource Integrity digest. Discovery is no-store; only the exact GET tarball path is reserved.

Responses:

- `200` [Release](#release)

### `POST /api/sdk/generate`

Resolve declarations against current company metadata and return finished managed files, uses stamps and typed declaration metadata. Requires the exact current release. Refuses connection_not_connected, patch_not_openable and release_mismatch. Present skills are sticky; an unknown present skill refuses generation. Includes core and implied skills, typed clients, contexts and fixture stubs. The metadata response field contains Postgres snapshots and shared-table definitions with recursive source ref targets and their shared declarations; it is never written to a generated file. Never returns manifest.json, credentials or business rows. Unknown fields anywhere in the body answer 400. The JSON body cap is 1 MiB: a declared larger length answers 413, and streaming bodies are cut off at the cap.

Request body: { release: string, manifest: { manifestVersion: integer, release: string, name?: string, description?: string, tier: 0 | 1 | 2 | 3, tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } }, files: { [key: string]: { description: string } }, uses: { [key: string]: { kind: "postgres", handle: string, id?: string, revision?: integer } | { kind: "sharedTable", patchId: string, table: string, id?: string, revision?: integer } } }, patchId?: string, skills: string[] }

Responses:

- `200` { ok: true, files: { path: string, contents: string }[], metadata: { postgres: { [key: string]: { declaration: { kind: "postgres", handle: string, id: string, revision: integer }, snapshot: { version: 1, relations: { schema: string, name: string, kind: "table" | "view", columns: { name: string, type: { schema: string, name: string, sql: string, baseSchema: string, baseName: string, kind: "base" | "enum" | "array", element?: { baseSchema: string, baseName: string, kind: "base" | "enum" } }, nullable: boolean }[], primaryKey: { name: string, columns: string[] } | null, foreignKeys: { name: string, columns: string[], target: { schema: string, relation: string, columns: string[] } }[] }[], enums: { schema: string, name: string, labels: string[] }[], exclusions: { schema: string, relation: string, column?: string, reason: "access_denied" | "relation_limit" | "column_limit" | "unsupported_type" | "reserved_name" | "key_limit" | "enum_limit" }[] } } }, shared: { [key: string]: { declaration: { kind: "sharedTable", patchId: string, table: string, id: string, revision: integer }, tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } }, uses: { [key: string]: { kind: "sharedTable", patchId: string, table: string, id: string, revision: integer } } } } }, uses: { alias: string, id: string, revision: integer }[] }
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `413` { ok: false, error: string }
- `422` { ok: false, error: string, code: "release_mismatch" | "invalid_manifest" | "tier_mismatch" | "has_primitives" | "patch_not_openable" | "connection_not_connected" | "stale_generated" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "busy" | "source_unavailable" }

## runtime

### `POST /api/runtime/call`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null and every other operation, including unknown ones, with `not_available_on_public`, with or without a session and before any principal check. Public shells always send a null principal. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); only `me` may bootstrap with null. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by default; `rate_limited` is 429 with `Retry-After` seconds. Responses, including failures, are `Cache-Control: no-store`. The JSON envelope is `{ patchId, versionId, principal, wire, op, args }`; its principal and wire must match the required headers. Mutating and integration operations require the exact shell `Origin` (scheme, host and port); a cross-site or missing Origin is refused before execution. `me` with `args: {}` returns `{ ok: true, value: { user: { id, name, email }, company: { id, handle, name }, admin } }` on company versions, or `{ ok: true, value: null }` on public versions; `admin` is a UI hint, not additional authority. The seven `tables.*` operations resolve tables and validate rows against the loaded version's manifest, not the newest version. `get` returns a row or null; `getMany` preserves input order and nulls; `insert`, `insertMany` and `update` return their rows; `delete` returns null, including for a missing row. `update` of a missing row is `row_not_found`. Defaults apply to omitted insert fields, optional fields accept null, and explicit null for a defaulted field is `invalid_row`. `list { table, index?, eq?, range?, order?, limit?, cursor? }` returns `{ rows, cursor }`. The default index is `(createdAt, id)`; `eq` constrains leading index columns, one `range { column, gt?, gte?, lt?, lte? }` constrains the next column, and `order` is `asc` or `desc` with an id tie-breaker. Keyset cursors are bound to table, index, filters and order. The page defaults to 100 rows and is capped at 1,000; `getMany` and `insertMany` are capped at 1,000 items and 8 MiB, individual rows at 1 MiB. List and getMany results are capped at 8 MiB, checking database JSON transport before decoding and final wire bytes afterward. Transport whitespace can make its check stricter. Native PostgreSQL B-tree key-size failures are `too_large`; publishing a non-unique index adds no separate size CHECK constraint or 2,000-byte runtime write limit. `shared.get { alias, id }`, `shared.getMany { alias, ids }` and `shared.list { alias, ... }` reuse those read contracts and source indexes, without writes. The alias resolves through the loaded consumer manifest to a stable source patch id and table. Every call checks source liveness, the viewer's same-company access and the inventory's shared flag; losing any of them fails the entire call with `access_denied`, including an empty getMany. While authorized, dangling ids remain null in input order. Source definitions come from cumulative inventory, so omission from the source's active manifest does not remove access. Deletion and recreation under the same patch name never rebind a declaration. `postgres.list`, `postgres.get`, `postgres.getMany` and `postgres.query` select a declared alias with `connection`; relation operations use `relation: { schema, name }`. The alias resolves through the loaded manifest to its stable connection id and pinned snapshot revision, with credentials and connected state checked live. Each operation returns `value: { ok: true, rows }`; list additionally returns `cursor`. No rowCount or truncated flag is returned. `get { key }` returns one row or null in rows; `getMany { keys }` preserves input order and missing-row nulls. Both require a usable source primary key. `list { eq?, range?, orderBy?, select?, limit?, cursor? }` quotes all identifiers and projects supported columns explicitly. `orderBy` is `{ column, direction: "asc" | "desc" }`, with primary-key tie breakers. Keyset cursors bind to connection, relation, snapshot, filters and order; unkeyed relations use offsets bounded to 10,000 (`offset_exhausted`). Default page 100, maximum 1,000. `query { sql, params, shape }` accepts scalar/null parameters and arrays of scalars. Shape columns are `{ kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json", optional? }`; defaults and refs are refused. Missing or duplicate columns and nulls in required columns fail `shape_mismatch`; extras are dropped. Integers must be safe; int8/numeric are strings, never silently rounded. Queries execute as one extended-protocol statement in a read-only transaction with a 10-second statement timeout and a 15-second deadline including queue wait. Every result is bounded during collection to 1,000 rows and 8 MiB; overflow fails the whole call. Pools allow four backends per connection, 64 per process and 60 seconds idle. Postgres failures include `relation_unknown`, `invalid_query`, `shape_mismatch`, `invalid_cursor`, `offset_exhausted` and integration boundary codes. `invalid_query` details retain the source message, SQLSTATE and position. Integration attempts are logged before execution, including denials and failures with trusted attribution; only query logs SQL text (up to 8 KiB), never parameters. Request bodies allow 1 MiB plus envelope for insert/update and 8 MiB plus envelope for insertMany; Postgres calls allow 256 KiB including parameters, and other calls 64 KiB. Overflow is `too_large` (413). Undeclared tables answer `table_not_declared`; invalid fields/defaults answer `invalid_row`, uniqueness conflicts `unique_violation`, and invalid pagination `invalid_cursor`. Unknown operations answer `invalid_request`. Failures are `{ ok: false, error, code, details?, correlationId? }`; every table mutation is logged before execution and logged failures carry their runtime-log correlation id. Table and file reads are not logged. `files.list { store, prefix?, limit?, cursor? }` returns `{ files: [{ name, size, contentType, updatedAt }], cursor }`, ordered by name with a literal prefix and a keyset cursor bound to patch, store and prefix. Pages default to 100, capped at 1,000 (`PATCHY_FILE_DEFAULT_PAGE`, `PATCHY_FILE_MAX_PAGE`), with an 8 MiB result cap (`PATCHY_RUNTIME_RESULT_BYTES`), including the cursor. `files.delete { store, name }` removes only the index row and returns null idempotently. File mutations log store/name as their resource. `files.put` and `files.get` require the raw bytes routes; they are refused on this JSON route, never serialized as JSON/base64.

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
- `504` [RuntimeFailure_7](#runtimefailure_7)

### `GET /api/runtime/files/:patchId/:versionId/:store/*`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null and every other operation, including unknown ones, with `not_available_on_public`, with or without a session and before any principal check. Public shells always send a null principal. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); only `me` may bootstrap with null. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by default; `rate_limited` is 429 with `Retry-After` seconds. Responses, including failures, are `Cache-Control: no-store`. GET additionally requires the exact browser header `Sec-Fetch-Site: same-origin`. Principal and wire travel only in their required headers; GET has no request body. The trailing `*` is the file name, not an object URL. Encode the full name with `encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. The wildcard also accepts slash-separated segments and avoids the router's 100-character named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; `store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or base64; the byte limit is 20 MiB (`PATCHY_RUNTIME_FILE_BYTES`), enforced against actual streamed bytes. Invalid names, undeclared stores and missing files answer `invalid_request`. Each PUT writes a fresh immutable object and changes the index only after the byte write succeeds. Files belong to the patch and store, never a version; rollback and version cleanup preserve them. The byte response carries the stored `Content-Type` and `no-store`, never a redirect to uploaded content. HTML and SVG remain bytes, never a navigable page.

Responses:

- `200` raw bytes (`application/octet-stream`)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `409` [RuntimeFailure_3](#runtimefailure_3)
- `413` [RuntimeFailure_4](#runtimefailure_4)
- `429` [RuntimeFailure_5](#runtimefailure_5)
- `503` [RuntimeFailure_6](#runtimefailure_6)
- `504` [RuntimeFailure_7](#runtimefailure_7)

### `PUT /api/runtime/files/:patchId/:versionId/:store/*`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null and every other operation, including unknown ones, with `not_available_on_public`, with or without a session and before any principal check. Public shells always send a null principal. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); only `me` may bootstrap with null. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by default; `rate_limited` is 429 with `Retry-After` seconds. Responses, including failures, are `Cache-Control: no-store`. PUT additionally requires the exact shell `Origin` (scheme, host and port). The uploaded media type travels as `Content-Type`. Principal and wire travel only in their required headers; the body contains only raw file bytes. The trailing `*` is the file name, not an object URL. Encode the full name with `encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. The wildcard also accepts slash-separated segments and avoids the router's 100-character named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; `store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or base64; the byte limit is 20 MiB (`PATCHY_RUNTIME_FILE_BYTES`), enforced against actual streamed bytes. Invalid names, undeclared stores and missing files answer `invalid_request`. Each PUT writes a fresh immutable object and changes the index only after the byte write succeeds. Files belong to the patch and store, never a version; rollback and version cleanup preserve them. An admitted PUT is logged before reading its body and answers `{ ok: true, value: null }` with `no-store`. A failed or oversized upload preserves the previous file.

Request body: raw bytes (`application/octet-stream`)

Responses:

- `200` [RuntimeSuccess](#runtimesuccess)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `409` [RuntimeFailure_3](#runtimefailure_3)
- `413` [RuntimeFailure_4](#runtimefailure_4)
- `429` [RuntimeFailure_5](#runtimefailure_5)
- `503` [RuntimeFailure_6](#runtimefailure_6)
- `504` [RuntimeFailure_7](#runtimefailure_7)

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
  fileSha256?: string | null,
  description?: string
}
```

### PublishRequest

```
{
  manifest: {
    manifestVersion: integer,
    release: string,
    name?: string,
    description?: string,
    tier: 0 | 1 | 2 | 3,
    tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } },
    files: { [key: string]: { description: string } },
    uses: { [key: string]: { kind: "postgres", handle: string, id: string, revision: integer } | { kind: "sharedTable", patchId: string, table: string, id: string, revision: integer } }
  },
  html: string,
  patchId?: string,
  scope?: "company" | "public",
  force?: boolean,
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
  warnings: string[],
  description: string,
  descriptionUpdatedAt: string | null
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
  warnings: string[],
  description: string,
  descriptionUpdatedAt: string | null
}
```

### PatchSummary

```
{
  id: string,
  name: string,
  address: string,
  owner: {
    id: string,
    name: string,
    deactivated: boolean
  },
  mine: boolean,
  tier: integer,
  scope: "company" | "public",
  description: string,
  state: "live" | "retired" | "deleted",
  retiredAt: string | null,
  deletedAt: string | null,
  purgeAt: string | null,
  currentVersion: integer,
  publishedAt: string
}
```

### PatchDetail

```
{
  id: string,
  name: string,
  address: string,
  owner: {
    id: string,
    name: string,
    deactivated: boolean
  },
  mine: boolean,
  tier: integer,
  scope: "company" | "public",
  description: string,
  state: "live" | "retired" | "deleted",
  retiredAt: string | null,
  deletedAt: string | null,
  purgeAt: string | null,
  currentVersion: integer,
  publishedAt: string,
  title: string,
  descriptionUpdatedAt: string | null,
  inventory: { tables: { name: string, description: string, shared: boolean, declarable: boolean, reason?: "not_shared" | "source_off", hint?: string }[], stores: { name: string, description: string, declarable: false, reason: "not_shareable", hint: string }[] } | null,
  reads: { alias: string, patchId: string, name?: string, table: string, state: "live" | "retired" | "deleted" | "gone" }[]
}
```

### PrimitiveDetail

```
{
  kind: "table" | "store",
  name: string,
  description: string,
  shared: boolean,
  schemaRevision: integer,
  columns: { name: string, kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json" | "ref", optional: boolean, default?: unknown, ref?: string }[],
  indexes: { name: string, columns: string[], unique: boolean }[]
}
```

### PatchInventory

```
{
  schemaRevision: integer,
  tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } },
  files: { [key: string]: { description: string } }
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

### ForceRequest

```
{
  force?: boolean
}
```

### Retired

```
{
  ok: true,
  patchId: string,
  state: "retired",
  retiredAt: string
}
```

### Deleted

```
{
  ok: true,
  patchId: string,
  state: "deleted",
  deletedAt: string,
  purgeAt: string
}
```

### Restored

```
{
  ok: true,
  patchId: string,
  state: "live"
}
```

### RollbackRequest

```
{
  versionNumber: integer
}
```

### RolledBack

```
{
  ok: true,
  patchId: string,
  currentVersion: integer,
  address: string
}
```

### DescriptionRequest

```
{
  description: string
}
```

### Described

```
{
  ok: true,
  patchId: string,
  description: string,
  descriptionUpdatedAt: string | null
}
```

### Release

```
{
  release: string,
  package: {
    tarball: string,
    integrity: string
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
{ patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.list", args: { connection: string, relation: { schema: string, name: string }, eq?: { [key: string]: string | number | boolean | null }, range?: { column: string, gt?: string | number | boolean | null, gte?: string | number | boolean | null, lt?: string | number | boolean | null, lte?: string | number | boolean | null }, orderBy?: { column: string, direction: "asc" | "desc" }, select?: string[], limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.get", args: { connection: string, relation: { schema: string, name: string }, key: { [key: string]: string | number | boolean | null } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.getMany", args: { connection: string, relation: { schema: string, name: string }, keys: { [key: string]: string | number | boolean | null }[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.query", args: { connection: string, sql: string, params: ((string | number | boolean | null) | (string | number | boolean | null)[])[], shape: { [key: string]: { kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json", optional?: boolean } } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "me", args: {} } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.get", args: { table: string, id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.getMany", args: { table: string, ids: string[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.list", args: { table: string, index?: string, eq?: { [key: string]: unknown }, range?: { column: string, gt?: unknown, gte?: unknown, lt?: unknown, lte?: unknown }, order?: "asc" | "desc", limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.get", args: { alias: string, id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.getMany", args: { alias: string, ids: string[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.list", args: { alias: string, index?: string, eq?: { [key: string]: unknown }, range?: { column: string, gt?: unknown, gte?: unknown, lt?: unknown, lte?: unknown }, order?: "asc" | "desc", limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.insert", args: { table: string, row: { [key: string]: unknown } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.insertMany", args: { table: string, rows: { [key: string]: unknown }[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.update", args: { table: string, id: string, patch: { [key: string]: unknown } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.delete", args: { table: string, id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.put", args: { store: string, name: string, contentType: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.get", args: { store: string, name: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.list", args: { store: string, prefix?: string, limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.delete", args: { store: string, name: string } }
```

### RuntimeMe

```
{ user: { id: string, email: string, name: string }, company: { id: string, handle: string, name: string }, admin: boolean } | null
```

### RuntimeSuccess

```
{
  ok: true,
  value: { ok: true, rows: { [key: string]: unknown }[], cursor: string | null } | { ok: true, rows: ({ [key: string]: unknown } | null)[] } | { ok: true, rows: { [key: string]: unknown }[] } | RuntimeMe | { [key: string]: unknown } | null | ({ [key: string]: unknown } | null)[] | { rows: { [key: string]: unknown }[], cursor: string | null } | { [key: string]: unknown }[] | { [key: string]: unknown } | { bytes: string, contentType: string } | { files: { name: string, size: integer, contentType: string, updatedAt: string }[], cursor: string | null } | null
}
```

### RuntimeCode

```
"connection_not_declared" | "access_denied" | "invalid_request" | "timeout" | "too_large" | "source_unavailable" | "table_not_declared" | "row_not_found" | "invalid_row" | "unique_violation" | "invalid_cursor" | "not_additive" | "relation_unknown" | "invalid_query" | "shape_mismatch" | "session_expired" | "principal_changed" | "not_available_on_public" | "shell_outdated" | "unknown_outcome" | "rate_limited" | "too_many_requests" | "busy" | "offset_exhausted"
```

### RuntimeFailure

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_1

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_2

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_3

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_4

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_5

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_6

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_7

```
{
  ok: false,
  error: string,
  code: RuntimeCode,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```
