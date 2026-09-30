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

Publish an HTML artifact, a manifest, and a server artifact on tier 2. Without `patchId` creates a patch (201); with an owned live `patchId` publishes a version (200). Authenticate, then replay by owner and `publishKey` before limits or release validation: identical payloads return the stored response and status, even after an upgrade; changed payloads answer 409 `publish_key_conflict`. New attempts require the exact current release and manifest version from `GET /api/release`. Tiers 0, 1 and 2 may define tables and file stores, provisioned additively; tier 3 answers `tier_mismatch`. Tier 2 is admitted on dev and test instances; production requires the fleet executor. Tier 2 requires `server`, a closed JavaScript module. Stored bytes are inspected in a throwaway process: descriptor disagreement, load failure or timeout answers `invalid_manifest`. A server artifact below tier 2 is `tier_mismatch`. Zero handlers warns. `artifacts.html` is always returned; tier 2 also returns `artifacts.server` and `handlers: [{name, kind}]` sorted by name. Both artifact records carry `sha256` and UTF-8 `bytes`. Publishing tier 2 to a public patch requires explicit company scope, otherwise `tier2_not_public`. Stored versions retain their wire; tier 2 wire 1 fixes the guest protocol and workerd compatibility date. Every table and file store requires a nonblank description; missing or blank descriptions and table/store name collisions answer `invalid_manifest`. The company directory is declared as `uses: { members: { kind: "members" } }`, without a resource id or schema stamp. Member columns require this declaration. Postgres uses carry `{ kind: "postgres", handle, id, revision }`, keyed by alias. The handle and id must name the same connected company connection, otherwise `connection_not_connected`; the revision must equal its current schema snapshot, otherwise `stale_generated` (run `patchy refresh`). Credential rotation and retargeting preserve the connection id. Postgres runtime calls retain the version's recorded snapshot. Shared-table uses carry `{ kind: "sharedTable", patchId, table, id, revision }`, keyed by alias. Shared-store uses carry `{ kind: "sharedStore", patchId, store, id, revision }`. The resolved id is `<patchId>/<table>` or `<patchId>/<store>`, never a patch name; revision stamps the source inventory. `files(description, { shared: true })` publishes read access to every file in the store. Publish requires a live same-company source the publisher can open and an inventory resource marked shared, otherwise `patch_not_openable`. A stamp behind the source revision warns, not refuses. Unsharing a defined table or store refuses with `has_dependants` and the distinct live declaring patches, including declarations in retained versions, unless `force` is true. Ask the person you are working for before forcing. Omission and rollback never change sharing. Ownership and lifecycle are checked before validating HTML and again at commit: another company's patch is 404; a same-company non-owner gets `not_owner` first, with the current owner. The owner gets `patch_retired` or `patch_deleted` with `purgeAt`, and must restore before publishing. Schema changes are checked before storage and rechecked under the patch lock. Preflight conservatively refuses new indexes with existing uncompressed key tuples over 2,000 bytes, and added columns that expand existing rows over the row limit. `not_additive` names every refused object, change and fix. Omitted tables and stores remain in the cumulative inventory with their data and appear as `unused`; a required column cannot be omitted. A new table or store cannot take a name the other kind holds in the inventory, even omitted. A publish replaces descriptions of the primitives it defines; omission and rollback preserve them. Description-only changes do not advance the schema revision. The revision advances for schema or sharing changes, never for a new bundle alone. File mode (empty definitions and no repo name, or file metadata) onto cumulative inventory answers `has_primitives`; an empty named repo manifest may omit all tables. Reports and schema revision are persisted for replay. Tier 0 HTML passes the safe-HTML policy; executable or otherwise unsafe content answers `tier_mismatch`. Empty or oversized tier 0 documents retain the HTML validation refusal. Tier 1 and 2 HTML bundles are stored raw, without safe-HTML validation or transformation. Tier 0 keeps `PATCHY_MAX_HTML_BYTES` (512 KiB); each scripted artifact uses `PATCHY_MAX_BUNDLE_BYTES` (10 MiB), with oversized artifacts refused as 413. Creates spend the per-token create limit and live-patch quota; updates do not. Omitted scope defaults to company on creates and remains unchanged on updates. `manifest.name` is an exact company-scoped name (3–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit); another patch's current name, or any name of a retired or deleted patch, answers 409 `name_taken` on create or rename. `patches` and `connections` are reserved names and answer 422 `reserved_name` on create. Without a name, creates derive one from `metadata.filename` without its extension (title when absent), normalize it, fall back to `patch` and add `-2`, `-3`, etc. on collision. Updates with no name retain their existing name. Rename leaves a redirect until another patch claims it; retire and delete reserve names until the deletion sweep reclaims the patch after 30 days. `manifest.description` or file mode's `metadata.description` updates the description; omitted, the cloud text remains. Descriptions collapse whitespace, permit at most 500 Unicode code points and no control characters, and are returned with `descriptionUpdatedAt`. `address` and `publicUrl` both name the absolute `/<company>/<name>` address. The JSON body cap is three times the sum of the larger configured HTML or bundle cap and the server bundle cap.

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
- `422` { ok: false, errors: string[], warnings: string[] } | { ok: false, error: string, code: "reserved_name" } | { ok: false, error: string, code: "invalid_description" } | { ok: false, error: string, code: "tier2_not_public" } | { ok: false, error: string, code: "not_additive", changes: { object: string, change: string, fix: string }[] } | { ok: false, error: string, code: "release_mismatch" | "invalid_manifest" | "tier_mismatch" | "has_primitives" | "patch_not_openable" | "connection_not_connected" | "stale_generated" }
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

Read one openable company patch by canonical id or exact name, using the same state filter as the list. Names resolve only non-deleted patches; ids resolve any retained state. A resolved patch outside the requested state answers 409 `wrong_state` with its actual state. Unknown, unopenable, disabled, foreign, gone and deleted-by-name references answer the same 404. The summary gains `title`, a cumulative `inventory: { tables, stores } | null`, and `reads` across every retained version, including declarations dropped by the current version. Existing in-company sources retain their lifecycle state even when disabled or unopenable; only openable sources expose a name. Source state does not imply permission to read it. Sources absent from the company lookup are `gone` without a name; foreign metadata is never queried. An unavailable company database means null inventory, never fabricated empty arrays. Live shared tables and stores are declarable and carry `patchy add shared-table <patchId>/<table>` or `patchy add shared-store <patchId>/<store>`. Unshared resources carry `not_shared` and an owner-name hint; off sources carry `source_off`. Reads identify stores with `store`, never a `table` field. No versions, dependants or business rows are returned. Machine tokens only. Overlong references answer 414. Responses are private, no-store.

Responses:

- `200` [PatchDetail](#patchdetail)
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `GET /api/patches/:patchRef/primitives/:name`

Read one table or file store from a patch's cumulative inventory with the detail route's id-or-name resolution, openability gate and state filter. Returns kind, name, description, sharing, schema revision, columns and indexes, never rows or contents. Columns report their name, kind, optional flag, an optional ref target and a default only when present; an explicit null default stays present. Indexes report name, columns and uniqueness. Stores have `kind: store`, live `shared` state and empty columns and indexes. Both kinds include `declarable`, a refusal `reason` when applicable and an add `hint`. A missing table or store answers 404; an unavailable inventory answers 503 `source_unavailable`, not a missing primitive. Machine tokens only. Overlong patch references answer 414. Responses are private, no-store.

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

Change the sharing scope of a patch owned by the bearer token's user, without publishing a version. `company` requires a company member's browser session; `public` lets anyone with the link open the current version. Only the current version of a public patch is public; older versions stay behind the company door. Public sharing while the served version is tier 2 answers `tier2_not_public`. A same-company non-owner answers 403 `not_owner`, including an admin's machine token; another company answers 404. Only live patches permit scope changes, otherwise `wrong_state`. The current public version may be cached for 60 seconds at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>`; older versions and company patches are `private, no-store` and answer 401 without a session. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`; the larger scripted-bundle cap applies only to publishing. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged.

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
- `422` { ok: false, error: string, code: "tier2_not_public" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/retire`

Retire an owned live patch. It stops serving and its shared tables and stores stop answering readers. Everything is retained indefinitely, including its names. Live dependants refuse with `has_dependants` unless `force` is true. Ask the person you are working for before forcing. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the patch unchanged.

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
- `409` { ok: false, error: string, code: "wrong_state", state: "live" | "retired" | "deleted" } | { ok: false, error: string, code: "sources_off", sources: ({ patchId: string, name?: string, table: string, state: "live" | "retired" | "deleted" | "gone" } | { patchId: string, name?: string, store: string, state: "live" | "retired" | "deleted" | "gone" })[] } | { ok: false, error: string, code: "patch_deleted", purgeAt: string }
- `413` { ok: false, error: string }
- `414` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }

### `POST /api/patches/:patchId/rollback`

Move an owned live patch's address to a retained `versionNumber`, creating no version. Tables, files, sharing, name and description do not change. A missing version answers 422 `version_unavailable`; an off patch answers `wrong_state`. A rollback to tier 2 while the patch is public answers `tier2_not_public`. The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. An oversized declared body answers 413; streaming bodies are cut off at the cap. Rejected requests leave the patch unchanged.

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
- `422` { ok: false, error: string, code: "version_unavailable" } | { ok: false, error: string, code: "tier2_not_public" }
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

- `200` { handle: string, description: string, status: "connected" | "disconnected", snapshot: { version: 1, relations: { schema: string, name: string, kind: "table" | "view", columns: { name: string, type: { schema: string, name: string, sql: string, baseSchema: string, baseName: string, kind: "base" | "enum" | "array", modifiers?: integer[], element?: { baseSchema: string, baseName: string, kind: "base" | "enum" } }, nullable: boolean }[], primaryKey: { name: string, columns: string[] } | null, foreignKeys: { name: string, columns: string[], target: { schema: string, relation: string, columns: string[] } }[] }[], enums: { schema: string, name: string, labels: string[] }[], exclusions: { schema: string, relation: string, column?: string, reason: "access_denied" | "relation_limit" | "column_limit" | "unsupported_type" | "reserved_name" | "key_limit" | "enum_limit" }[], revision: integer, takenAt: string } | null }
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "connection_storage_failed" }

## sdk

### `GET /api/release`

The current tooling release, manifest and wire versions, and the builder toolchain's tested versions and accepted ranges. Unauthenticated. GET /sdk/patchy-<release>-<digest>.tgz serves the exact tarball without authentication with Cache-Control: public, max-age=31536000, immutable. The URL digest is lowercase SHA-256; integrity is the SHA-512 Subresource Integrity digest of those bytes. Every advertised URL remains retrievable after an upgrade or same-version rebuild. Discovery is no-store. Only GET tarball-shaped paths are reserved; sdk remains a valid company handle. Unknown or malformed archive names answer 404; storage failure or corrupt bytes answer 503, both no-store.

Responses:

- `200` [Release](#release)

### `POST /api/sdk/generate`

Resolve declarations against current company metadata and return finished managed files, uses stamps and typed declaration metadata. Requires the exact current release. Refuses connection_not_connected, patch_not_openable and release_mismatch. Present skills are sticky except patchy-server below tier 2 and patchy-members without uses.members; generation removes those skills. An unknown present skill refuses generation. Includes core and implied skills, typed clients, contexts and fixture stubs. The metadata response field contains Postgres snapshots, shared-table definitions with recursive source ref targets and their shared declarations, and shared-store definitions. Store fixtures use `fixtures/shared-<alias>/README.md`; existing fixture directories are never overwritten. Metadata is never written to a generated file. Never returns manifest.json, credentials or business rows or bytes. serverModules lists one-level server/*.ts filename stems discovered locally for tier 2, independent of manifest.handlers; tiers 0 and 1 send an empty list. Generation uses them only for type-only imports and never loads handler code. Unknown fields anywhere in the body answer 400. The JSON body cap is 1 MiB: a declared larger length answers 413, and streaming bodies are cut off at the cap.

Request body: { release: string, manifest: { manifestVersion: integer, release: string, name?: string, description?: string, tier: 0 | 1 | 2 | 3, tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "member", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } }, files: { [key: string]: { description: string, shared?: boolean } }, uses: { [key: string]: { kind: "members" } | { kind: "postgres", handle: string, id?: string, revision?: integer } | { kind: "sharedTable", patchId: string, table: string, id?: string, revision?: integer } | { kind: "sharedStore", patchId: string, store: string, id?: string, revision?: integer } }, handlers?: { [key: string]: { kind: "query" | "mutation" | "action", args: { [key: string]: [HandlerSchema](#handlerschema) }, result: [HandlerSchema](#handlerschema), errors?: string[] } }, sdkImports?: string[] }, serverModules: string[], patchId?: string, skills: string[] }

Responses:

- `200` { ok: true, files: { path: string, contents: string }[], metadata: { postgres: { [key: string]: { declaration: { kind: "postgres", handle: string, id: string, revision: integer }, snapshot: { version: 1, relations: { schema: string, name: string, kind: "table" | "view", columns: { name: string, type: { schema: string, name: string, sql: string, baseSchema: string, baseName: string, kind: "base" | "enum" | "array", modifiers?: integer[], element?: { baseSchema: string, baseName: string, kind: "base" | "enum" } }, nullable: boolean }[], primaryKey: { name: string, columns: string[] } | null, foreignKeys: { name: string, columns: string[], target: { schema: string, relation: string, columns: string[] } }[] }[], enums: { schema: string, name: string, labels: string[] }[], exclusions: { schema: string, relation: string, column?: string, reason: "access_denied" | "relation_limit" | "column_limit" | "unsupported_type" | "reserved_name" | "key_limit" | "enum_limit" }[] } } }, shared: { [key: string]: { declaration: { kind: "sharedTable", patchId: string, table: string, id: string, revision: integer }, tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "member", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } }, uses: { [key: string]: { kind: "sharedTable", patchId: string, table: string, id: string, revision: integer } } } | { declaration: { kind: "sharedStore", patchId: string, store: string, id: string, revision: integer }, definition: { description: string, shared?: boolean } } } }, uses: { alias: string, id: string, revision: integer }[] }
- `400` { ok: false, error: string }
- `401` { ok: false, error: "Missing or invalid API token." }
- `404` { ok: false, error: string }
- `413` { ok: false, error: string }
- `422` { ok: false, error: string, code: "release_mismatch" | "invalid_manifest" | "tier_mismatch" | "has_primitives" | "patch_not_openable" | "connection_not_connected" | "stale_generated" }
- `429` { ok: false, error: string, code: "rate_limited", retryAfterSeconds: integer }
- `503` { ok: false, error: string, code: "busy" | "source_unavailable" }

## runtime

### `POST /api/runtime/call`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null. Public tier 1 versions admit declared `members.*` reads only for active signed-in members of the patch's company; all other data operations, including unknown ones, return `not_available_on_public`. Public HTML contains no viewer identity. Before directory work, the trusted shell uses the internal `principal` operation with a null principal to bind `{ userId }`, then pins that principal for directory calls and streams. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); company `me` may bootstrap with null. Tier 2 documents admit handle redemption (`files.redeem`) but refuse direct name-based primitives and integrations with `server_required`, even after rollback to a lower served tier. A loaded lower-tier document cannot redeem handles and gets only `me` while tier 2 is served. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by the release contract; `rate_limited` is 429 with `Retry-After` seconds. Company admission also uses a per-host-replica token bucket, 100 calls/second with burst 200 by default, overridable per company. It counts company-scoped operations even without a database connection; public `me` calls spend only their per-caller allowance. Company admission refuses with `limit_exceeded` (429), `company.admission.rate`, scope `company`, the enforced rate and `retryAfter`. Callbacks and subscription re-runs do not consume another company admission. Company connections default to four slots with at most 32 waiters and a one-second wait inside the caller's deadline; queue overflow or expiry is `busy` (503) with its limit metadata and `retryAfter`. Registered limit refusals add `scope`, `limitId` and `value` (the enforced bound). `retryAfter` is in seconds and is included only when retrying is safe, never for timeouts or unknown outcomes. Runtime rate refusals identify the viewer's call rate, company admission rate, or host tracked-key capacity. Registry-backed request, row, batch, result and file size refusals, mutation and integration deadlines, and broker frame limits carry these fields. Wire request size bounds include any envelope allowance. Other bounds, such as row counts and database statement timeouts, may omit them. Contract bounds are fixed per release, as listed in `docs/limits.md`. Responses, including failures, are `Cache-Control: no-store`. The JSON envelope is `{ patchId, versionId, principal, wire, op, args }`; its principal and wire must match the required headers. Mutating and integration operations require the exact shell `Origin` (scheme, host and port); a cross-site or missing Origin is refused before execution. `me` with `args: {}` returns `{ ok: true, value: { user: { id, name, email }, company: { id, handle, name }, admin } }` on company versions, or `{ ok: true, value: null }` on public versions; `admin` is a UI hint, not additional authority. The seven `tables.*` operations resolve tables and validate rows against the loaded version's manifest, not the newest version. `get` returns a row or null; `getMany` preserves input order and nulls; `insert`, `insertMany` and `update` return their rows; `delete` returns null, including for a missing row. `update` of a missing row is `row_not_found`. Defaults apply to omitted insert fields, optional fields accept null, and explicit null for a defaulted field is `invalid_row`. `list { table, index?, eq?, range?, order?, limit?, cursor? }` returns `{ rows, cursor }`. The default index is `(createdAt, id)`; `eq` constrains leading index columns, one `range { column, gt?, gte?, lt?, lte? }` constrains the next column, and `order` is `asc` or `desc` with an id tie-breaker. Keyset cursors are bound to table, index, filters and order. The page defaults to 100 rows and is capped at 1,000; `getMany` and `insertMany` are capped at 1,000 items and 8 MiB, individual rows at 1 MiB. List and getMany results are capped at 8 MiB, checking database JSON transport before decoding and final wire bytes afterward. Transport whitespace can make its check stricter. Native PostgreSQL B-tree key-size failures are `too_large`; publishing a non-unique index adds no separate size CHECK constraint or 2,000-byte runtime write limit. `shared.get { alias, id }`, `shared.getMany { alias, ids }` and `shared.list { alias, ... }` reuse those read contracts and source indexes, without writes. The alias resolves through the loaded consumer manifest to a stable source patch id and table. Every call checks source liveness, the viewer's same-company access and the inventory's shared flag; losing any of them fails the entire call with `access_denied`, including an empty getMany. While authorized, dangling ids remain null in input order. Source definitions come from cumulative inventory, so omission from the source's active manifest does not remove access. Deletion and recreation under the same patch name never rebind a declaration. `members.list { cursor? }` and `members.search { text, cursor? }` return active company candidates as `{ rows, cursor }`, in pages of 50. Search matches a literal, case-insensitive prefix of the full name or email, not a surname or substring. Order is lowercased name, lowercased email, then id; cursors bind to company and search. `members.get { id }` resolves any company user, including deactivated users; `members.getMany { ids }` preserves input order and duplicates with null for unknown or other-company ids. More than 1,000 ids is `limit_exceeded` with `members.getMany`. Each member is `{ id, name, email, admin, active }`. These reads require the fixed `members` declaration and active same-company viewer authority, including on public tier 1 documents. All four operations subscribe to the company directory revision. Tier 2 handlers may read the directory in all three kinds; only queries track dependencies. Directory reads use the platform database, outside the query's company-database snapshot. A `member` column stores a user id and rejects a non-candidate with `invalid_row` on insertion or changed assignment. Member columns may be optional but cannot have defaults. An unchanged inactive id passes. Eligibility is checked when the write arrives, not when its transaction commits. `postgres.list`, `postgres.get`, `postgres.getMany` and `postgres.query` select a declared alias with `connection`; relation operations use `relation: { schema, name }`. The alias resolves through the loaded manifest to its stable connection id and pinned snapshot revision, with credentials and connected state checked live. Each operation returns `value: { ok: true, rows }`; list additionally returns `cursor`. No rowCount or truncated flag is returned. `get { key }` returns one row or null in rows; `getMany { keys }` preserves input order and missing-row nulls. Both require a usable source primary key. `list { eq?, range?, orderBy?, select?, limit?, cursor? }` quotes all identifiers and projects supported columns explicitly. `orderBy` is `{ column, direction: "asc" | "desc" }`, with primary-key tie breakers. Keyset cursors bind to connection, relation, snapshot, filters and order; unkeyed relations use offsets bounded to 10,000 (`offset_exhausted`). Default page 100, maximum 1,000. `query { sql, params, shape }` accepts scalar/null parameters and arrays of scalars. Shape columns are `{ kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json", optional? }`; defaults and refs are refused. Missing or duplicate columns and nulls in required columns fail `shape_mismatch`; extras are dropped. Integers must be safe; int8/numeric are strings, never silently rounded. Queries execute as one extended-protocol statement in a read-only transaction with a 10-second statement timeout and a 15-second deadline including queue wait. Every result is bounded during collection to 1,000 rows and 8 MiB; overflow fails the whole call. Pools allow four backends per connection, 64 per process and 60 seconds idle. Postgres failures include `relation_unknown`, `invalid_query`, `shape_mismatch`, `invalid_cursor`, `offset_exhausted` and integration boundary codes. `invalid_query` details retain the source message, SQLSTATE and position. Integration attempts are logged before execution, including denials and failures with trusted attribution; only query logs SQL text (up to 8 KiB), never parameters. `server.call { handler, args, mutationKey? }` names a one-level `module.export`. Its declared business refusal is HTTP 200 `{ ok: false, source: "handler", code, details? }`; successful handler data stays inside `{ ok: true, value }`, even when the value resembles a refusal. Runtime validates the loaded version's handler descriptors and dispatches through its Executor. Admission requires a live session, an eligible loaded version and company scope; public documents cannot call handlers. Tier 2 documents cannot make name-based direct primitive or connection calls, even after rollback to tier 1 (`server_required`). While tier 2 is served, an older tier 1 document may call only `me`. Action concurrency defaults to eight per company and two per viewer per patch (`busy`). The host owns deadlines independently of the HTTP caller: 3 s for queries, 5 s for mutations, 60 s for actions, plus at most 5 s for cleanup. Unresolved effects remain `unknown_outcome`, never `handler_timeout`; a late guest reply cannot restore authority. Mutations commit owned-table writes, their key and a validated result of at most 64 KiB in one SERIALIZABLE transaction. A `40001` retries the whole handler up to three attempts in the original deadline; exhaustion is `write_conflict`, never `busy`. Mutation calls require a fresh `<ms>-<128 random bits, base64url>` key using the stream's server clock. A repeat returns the committed result; expired keys over 24 hours old, keys over five minutes ahead, and changed bindings or arguments are refused. The client's mutation `unknown_outcome.retry()` re-sends that key and captured arguments; actions are never replayed. Successful mutation replies include `revisions`, the resource revision vector committed with their writes. `handler_failed` carries a host correlation id; exception messages and stacks remain in the invocation log. The isolated local executor exercises this host path. Request bodies allow 1 MiB plus envelope for insert/update and 8 MiB plus envelope for insertMany; server.call handler arguments allow 1 MiB (`tier2.args.bytes`) with a 64 KiB allowance for the enclosing request. Postgres calls allow 256 KiB including parameters, and other calls 64 KiB. Overflow is `too_large` (413). Undeclared tables answer `table_not_declared`; invalid fields/defaults answer `invalid_row`, uniqueness conflicts `unique_violation`, and invalid pagination `invalid_cursor`. Unknown operations answer `invalid_request`. Patchy refusals use a non-200 status and `{ ok: false, source: "patchy", error, code, details?, correlationId?, scope?, limitId?, value?, retryAfter? }`; every table mutation is logged before execution and logged failures carry their runtime-log correlation id. Table and file mutations have a 30-second deadline (`runtime.mutation.deadline`), the same one their log records; past it the call fails `timeout` (504). Table and file reads are not logged. `files.list { store, prefix?, limit?, cursor? }` returns `{ files: [{ name, size, contentType, updatedAt }], cursor }`, ordered by name with a literal prefix and a keyset cursor bound to patch, store and prefix. Pages default to 100, capped at 1,000 (`PATCHY_FILE_DEFAULT_PAGE`, `PATCHY_FILE_MAX_PAGE`), with an 8 MiB result cap (`runtime.result.bytes`), including the cursor. Tier 2 callback list/stat metadata additionally includes a host-minted `handle`: 57 characters, deterministic for viewer, company, consuming patch, loaded version, source store and exact immutable object, with no filename or clock. Handles count against page and result bounds. Nested `ctx.run` results retain the parent's binding. A handle preserves the handler's selection until replacement or deletion; narrowing a row does not revoke an already returned handle. `shared.files.list { alias, prefix?, limit?, cursor? }` uses the same page contract. `shared.files.stat { alias, name }` returns metadata or null. Both recheck source access and sharing live. Tier 2 queries and actions may list and stat; only actions may get bytes. `files.delete { store, name }` removes only the index row and returns null idempotently. File mutations log store/name as their resource. `files.put`, `files.get`, `shared.files.get` and `files.redeem` require raw bytes routes; they are refused on this JSON route, never serialized as JSON/base64. `files.discard { upload }` releases a staged upload and returns null without an operation log. It requires a loaded tier 2 document, the exact shell Origin, and the stage's company, viewer, patch and version binding. Missing, expired or consumed stages return `not_found`. Public JSON files.put remains refused, including the upload-adoption form reserved for private action callbacks.

Request body: [RuntimeCall](#runtimecall)

Responses:

- `200` [ServerCallReply](#servercallreply)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

### `PUT /api/runtime/staged-files/:patchId/:versionId`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null. Public tier 1 versions admit declared `members.*` reads only for active signed-in members of the patch's company; all other data operations, including unknown ones, return `not_available_on_public`. Public HTML contains no viewer identity. Before directory work, the trusted shell uses the internal `principal` operation with a null principal to bind `{ userId }`, then pins that principal for directory calls and streams. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); company `me` may bootstrap with null. Tier 2 documents admit handle redemption (`files.redeem`) but refuse direct name-based primitives and integrations with `server_required`, even after rollback to a lower served tier. A loaded lower-tier document cannot redeem handles and gets only `me` while tier 2 is served. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by the release contract; `rate_limited` is 429 with `Retry-After` seconds. Company admission also uses a per-host-replica token bucket, 100 calls/second with burst 200 by default, overridable per company. It counts company-scoped operations even without a database connection; public `me` calls spend only their per-caller allowance. Company admission refuses with `limit_exceeded` (429), `company.admission.rate`, scope `company`, the enforced rate and `retryAfter`. Callbacks and subscription re-runs do not consume another company admission. Company connections default to four slots with at most 32 waiters and a one-second wait inside the caller's deadline; queue overflow or expiry is `busy` (503) with its limit metadata and `retryAfter`. Registered limit refusals add `scope`, `limitId` and `value` (the enforced bound). `retryAfter` is in seconds and is included only when retrying is safe, never for timeouts or unknown outcomes. Runtime rate refusals identify the viewer's call rate, company admission rate, or host tracked-key capacity. Registry-backed request, row, batch, result and file size refusals, mutation and integration deadlines, and broker frame limits carry these fields. Wire request size bounds include any envelope allowance. Other bounds, such as row counts and database statement timeouts, may omit them. Contract bounds are fixed per release, as listed in `docs/limits.md`. Responses, including failures, are `Cache-Control: no-store`. Stages raw bytes for a tier 2 action. Requires the exact shell Origin and normal principal and wire headers. Returns `{ ok: true, value: { token, size, contentType } }` with no-store. The opaque token binds company, viewer, consuming patch and loaded version. Staging and discard are unlogged transport; neither operation is available to handler callbacks. An action adopts with `files.put { store, name, upload }` through its private callback; that mutation is logged as files.put and keeps the staged content type. Before the action handler runs, the host resolves all t.upload metadata from its stage records. Adoption and a subsequent mutation are not atomic. An upload is single-use and expires after one hour. Limits are 20 MiB per stage, 16 outstanding stages and 100 MiB per viewer per patch, and 1 GiB outstanding per company.

Request body: raw bytes (`application/octet-stream`)

Responses:

- `200` [RuntimeSuccess](#runtimesuccess)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

### `GET /api/runtime/files/:patchId/:versionId/:store/*`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null. Public tier 1 versions admit declared `members.*` reads only for active signed-in members of the patch's company; all other data operations, including unknown ones, return `not_available_on_public`. Public HTML contains no viewer identity. Before directory work, the trusted shell uses the internal `principal` operation with a null principal to bind `{ userId }`, then pins that principal for directory calls and streams. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); company `me` may bootstrap with null. Tier 2 documents admit handle redemption (`files.redeem`) but refuse direct name-based primitives and integrations with `server_required`, even after rollback to a lower served tier. A loaded lower-tier document cannot redeem handles and gets only `me` while tier 2 is served. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by the release contract; `rate_limited` is 429 with `Retry-After` seconds. Company admission also uses a per-host-replica token bucket, 100 calls/second with burst 200 by default, overridable per company. It counts company-scoped operations even without a database connection; public `me` calls spend only their per-caller allowance. Company admission refuses with `limit_exceeded` (429), `company.admission.rate`, scope `company`, the enforced rate and `retryAfter`. Callbacks and subscription re-runs do not consume another company admission. Company connections default to four slots with at most 32 waiters and a one-second wait inside the caller's deadline; queue overflow or expiry is `busy` (503) with its limit metadata and `retryAfter`. Registered limit refusals add `scope`, `limitId` and `value` (the enforced bound). `retryAfter` is in seconds and is included only when retrying is safe, never for timeouts or unknown outcomes. Runtime rate refusals identify the viewer's call rate, company admission rate, or host tracked-key capacity. Registry-backed request, row, batch, result and file size refusals, mutation and integration deadlines, and broker frame limits carry these fields. Wire request size bounds include any envelope allowance. Other bounds, such as row counts and database statement timeouts, may omit them. Contract bounds are fixed per release, as listed in `docs/limits.md`. Responses, including failures, are `Cache-Control: no-store`. GET additionally requires the exact browser header `Sec-Fetch-Site: same-origin`. Principal and wire travel only in their required headers; GET has no request body. The trailing `*` is the file name, not an object URL. Encode the full name with `encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. The wildcard also accepts slash-separated segments and avoids the router's 100-character named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; `store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or base64; the byte limit is 20 MiB (`runtime.file.bytes`), enforced against actual streamed bytes. Invalid names, undeclared stores and missing files answer `invalid_request`. Each PUT writes a fresh immutable object and changes the index only after the byte write succeeds. Files belong to the patch and store, never a version; rollback and version cleanup preserve them. The byte response carries the stored `Content-Type` and `no-store`, never a redirect to uploaded content. HTML and SVG remain bytes, never a navigable page.

Responses:

- `200` raw bytes (`application/octet-stream`)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

### `PUT /api/runtime/files/:patchId/:versionId/:store/*`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null. Public tier 1 versions admit declared `members.*` reads only for active signed-in members of the patch's company; all other data operations, including unknown ones, return `not_available_on_public`. Public HTML contains no viewer identity. Before directory work, the trusted shell uses the internal `principal` operation with a null principal to bind `{ userId }`, then pins that principal for directory calls and streams. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); company `me` may bootstrap with null. Tier 2 documents admit handle redemption (`files.redeem`) but refuse direct name-based primitives and integrations with `server_required`, even after rollback to a lower served tier. A loaded lower-tier document cannot redeem handles and gets only `me` while tier 2 is served. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by the release contract; `rate_limited` is 429 with `Retry-After` seconds. Company admission also uses a per-host-replica token bucket, 100 calls/second with burst 200 by default, overridable per company. It counts company-scoped operations even without a database connection; public `me` calls spend only their per-caller allowance. Company admission refuses with `limit_exceeded` (429), `company.admission.rate`, scope `company`, the enforced rate and `retryAfter`. Callbacks and subscription re-runs do not consume another company admission. Company connections default to four slots with at most 32 waiters and a one-second wait inside the caller's deadline; queue overflow or expiry is `busy` (503) with its limit metadata and `retryAfter`. Registered limit refusals add `scope`, `limitId` and `value` (the enforced bound). `retryAfter` is in seconds and is included only when retrying is safe, never for timeouts or unknown outcomes. Runtime rate refusals identify the viewer's call rate, company admission rate, or host tracked-key capacity. Registry-backed request, row, batch, result and file size refusals, mutation and integration deadlines, and broker frame limits carry these fields. Wire request size bounds include any envelope allowance. Other bounds, such as row counts and database statement timeouts, may omit them. Contract bounds are fixed per release, as listed in `docs/limits.md`. Responses, including failures, are `Cache-Control: no-store`. PUT additionally requires the exact shell `Origin` (scheme, host and port). The uploaded media type travels as `Content-Type`. Principal and wire travel only in their required headers; the body contains only raw file bytes. The trailing `*` is the file name, not an object URL. Encode the full name with `encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. The wildcard also accepts slash-separated segments and avoids the router's 100-character named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; `store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or base64; the byte limit is 20 MiB (`runtime.file.bytes`), enforced against actual streamed bytes. Invalid names, undeclared stores and missing files answer `invalid_request`. Each PUT writes a fresh immutable object and changes the index only after the byte write succeeds. Files belong to the patch and store, never a version; rollback and version cleanup preserve them. An admitted PUT is logged before reading its body and answers `{ ok: true, value: null }` with `no-store`. The 30-second mutation deadline includes reading the body; past it the PUT fails `timeout` (504). A failed or oversized upload preserves the previous file.

Request body: raw bytes (`application/octet-stream`)

Responses:

- `200` [RuntimeSuccess](#runtimesuccess)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

### `GET /api/runtime/shared-files/:patchId/:versionId/:alias/*`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null. Public tier 1 versions admit declared `members.*` reads only for active signed-in members of the patch's company; all other data operations, including unknown ones, return `not_available_on_public`. Public HTML contains no viewer identity. Before directory work, the trusted shell uses the internal `principal` operation with a null principal to bind `{ userId }`, then pins that principal for directory calls and streams. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); company `me` may bootstrap with null. Tier 2 documents admit handle redemption (`files.redeem`) but refuse direct name-based primitives and integrations with `server_required`, even after rollback to a lower served tier. A loaded lower-tier document cannot redeem handles and gets only `me` while tier 2 is served. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by the release contract; `rate_limited` is 429 with `Retry-After` seconds. Company admission also uses a per-host-replica token bucket, 100 calls/second with burst 200 by default, overridable per company. It counts company-scoped operations even without a database connection; public `me` calls spend only their per-caller allowance. Company admission refuses with `limit_exceeded` (429), `company.admission.rate`, scope `company`, the enforced rate and `retryAfter`. Callbacks and subscription re-runs do not consume another company admission. Company connections default to four slots with at most 32 waiters and a one-second wait inside the caller's deadline; queue overflow or expiry is `busy` (503) with its limit metadata and `retryAfter`. Registered limit refusals add `scope`, `limitId` and `value` (the enforced bound). `retryAfter` is in seconds and is included only when retrying is safe, never for timeouts or unknown outcomes. Runtime rate refusals identify the viewer's call rate, company admission rate, or host tracked-key capacity. Registry-backed request, row, batch, result and file size refusals, mutation and integration deadlines, and broker frame limits carry these fields. Wire request size bounds include any envelope allowance. Other bounds, such as row counts and database statement timeouts, may omit them. Contract bounds are fixed per release, as listed in `docs/limits.md`. Responses, including failures, are `Cache-Control: no-store`. Read-only shared-store bytes. The alias resolves through the loaded consumer manifest's `sharedStore` declaration to a stable source patch id and store. The wildcard is the file name, encoded once; slash-separated names are supported. Every read, URL creation and download checks live source access and cumulative store sharing, otherwise `access_denied`. A tier 1 consumer may read a tier 2 source. A document below its own patch's served tier gets `server_required`. GET requires `Sec-Fetch-Site: same-origin`, the principal and wire headers, and no body. Responses are raw bytes under the same 20 MiB limit as owned files, with the stored media type, `no-store`, attachment disposition and a sandbox CSP. There are no shared writes.

Responses:

- `200` raw bytes (`application/octet-stream`)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

### `GET /api/runtime/file-handles/:patchId/:versionId/:handle`

Browser-only: no bearer middleware, and machine tokens are refused. Every request requires `X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or `{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. A public version answers `me` with null. Public tier 1 versions admit declared `members.*` reads only for active signed-in members of the patch's company; all other data operations, including unknown ones, return `not_available_on_public`. Public HTML contains no viewer identity. Before directory work, the trusted shell uses the internal `principal` operation with a null principal to bind `{ userId }`, then pins that principal for directory calls and streams. Company versions require a browser session (`session_expired`), a viewer who can open the patch (`access_denied`), and a principal matching that session's user (`principal_changed`); company `me` may bootstrap with null. Tier 2 documents admit handle redemption (`files.redeem`) but refuse direct name-based primitives and integrations with `server_required`, even after rollback to a lower served tier. A loaded lower-tier document cannot redeem handles and gets only `me` while tier 2 is served. Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls are limited to 300 per minute by the release contract; `rate_limited` is 429 with `Retry-After` seconds. Company admission also uses a per-host-replica token bucket, 100 calls/second with burst 200 by default, overridable per company. It counts company-scoped operations even without a database connection; public `me` calls spend only their per-caller allowance. Company admission refuses with `limit_exceeded` (429), `company.admission.rate`, scope `company`, the enforced rate and `retryAfter`. Callbacks and subscription re-runs do not consume another company admission. Company connections default to four slots with at most 32 waiters and a one-second wait inside the caller's deadline; queue overflow or expiry is `busy` (503) with its limit metadata and `retryAfter`. Registered limit refusals add `scope`, `limitId` and `value` (the enforced bound). `retryAfter` is in seconds and is included only when retrying is safe, never for timeouts or unknown outcomes. Runtime rate refusals identify the viewer's call rate, company admission rate, or host tracked-key capacity. Registry-backed request, row, batch, result and file size refusals, mutation and integration deadlines, and broker frame limits carry these fields. Wire request size bounds include any envelope allowance. Other bounds, such as row counts and database statement timeouts, may omit them. Contract bounds are fixed per release, as listed in `docs/limits.md`. Responses, including failures, are `Cache-Control: no-store`. Redeems a file selected by a tier 2 handler, with the signed-in viewer's normal principal and wire headers and `Sec-Fetch-Site: same-origin`. The 57-character handle binds viewer, company, consuming patch, loaded version, source store and immutable object. The MAC is checked first, then the current name pointer (`not_found`), then live source access (`access_denied`). Every request rechecks authority, and reads are not logged. The response is raw bytes with stored `Content-Type`, `no-store`, sandbox CSP, attachment disposition and `X-Patchy-File-Name` containing the exact URI-encoded name. Lower-tier documents cannot redeem handles, including when their patch serves tier 2.

Responses:

- `200` raw bytes (`application/octet-stream`)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

## runtimeStream

### `GET /api/runtime/stream`

Browser-cookie authentication only; bearer tokens are refused. `X-Patchy-Wire` is the decimal runtime wire; `X-Patchy-Principal` is JSON `{"userId":"..."}` matching the current admitted viewer, never null. GET opens one fetch-streamed SSE connection per authenticated document on tiers 1 and 2. `patchId` and `versionId` identify the retained loaded version; `documentId` is the shell's 16–128 character base64url nonce. `Sec-Fetch-Site: same-origin` is required. Every reconnect checks the session, company and loaded version again. Company shells bootstrap this stream; public tier 1 shells open it lazily for declared member-directory subscriptions after binding the authenticated principal. An authenticated company document keeps its stream if the patch becomes public. Frames are `data: <JSON>\n\n`, without an event field. The first frame is `{type:'hello',generation,serverTime}`, with an opaque generation and Unix milliseconds; the current `{type:'served',versionId,tier}` follows. Dev also sends `{type:'handlers',kinds}` with the complete host-inspected handler-kind map on open/reconnect and before subscription wakes after each successful server rebind. The trusted shell forwards this replacement to the existing document so newly added mutations receive client-minted mutation keys without a page reload. Replacing an open document requires its latest generation in `X-Patchy-Generation`; a stale replacement is `invalid_request` (409). A successful stream sets the opaque `patchy_stream_affinity` cookie, scoped to `/api/runtime` with `HttpOnly` and `SameSite=Strict`; it is `Secure` when the trusted public base URL uses HTTPS. Multi-replica ingress must enable application-cookie stickiness with cookie name `patchy_stream_affinity`, routing the stream and its subscription POSTs to the same replica. Round-robin routing without affinity is unsupported. If failover loses the generation, a 409 triggers reconnect and fresh admission. Publish and rollback send `served`; lost authority sends `access_denied`, `principal_changed` or `session_expired`. `revoked` is reserved pending the version-revocation decision in #425; no version-revocation state or action exists yet. Tier 2 opens and resumes send `starting` while ensuring a company task binding, then `ready`. The broker holds `server.call` requests within its frame bounds until ready; invocation deadlines begin only at admission. A stream drop keeps held calls held. After 40 seconds without a binding, `start_failed` (`code:'busy'`, `retryAfter` seconds, and the effective `scope`, `limitId`, `value`) refuses held calls once, without replay. The shell covers the frame after two seconds, on first open and resume, with an accessible focus-held starting element. Failure offers Retry and automatic backoff while the document stays open; later ready admits only new calls. `closed` names `slow_consumer` or `replaced`. Network drops and host drain reconnect with backoff; hidden documents suspend after 30 seconds, then re-admit on return without changing loaded version. Expiry of the authenticated token ends the stream normally. A refreshable stale token answers `session_refresh_required` (401), so the browser refreshes its cookie without discarding the document. Only definitive session loss is `session_expired`. Tier 1 table and member-directory subscriptions share this stream with tier 2 query subscriptions. The registry bounds `stream.documents` at 8 per viewer per patch and `stream.buffer.bytes` at 16 MiB; overflow closes with `slow_consumer`.

Responses:

- `200` SSE (`text/event-stream`), JSON data: [RuntimeStreamFrame](#runtimestreamframe)
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

### `POST /api/runtime/subscriptions`

Browser-cookie authentication only; bearer tokens are refused. `X-Patchy-Wire` must be the current decimal runtime wire, `X-Patchy-Principal` must be JSON `{"userId":"..."}` matching the admitted viewer and never null, and `Sec-Fetch-Site: same-origin` is required. Reconcile a document's subscriptions using its loaded version, document nonce and current stream generation. Control requests share `runtime.calls.perMinute` with ordinary calls for the same viewer and patch; exhaustion is `rate_limited` (429) with `Retry-After`. Public loaded tier 1 versions admit only declared `members.*` subscriptions for same-company viewers; other data subscriptions return `not_available_on_public` without closing the lifecycle stream. Retained company versions remain eligible. Deltas `{type:'subscribe',sequence,subscription}` and `{type:'unsubscribe',sequence,id}` apply in order, starting at sequence 1. A subscription is `{id,op,args,vector?,revision?}`; tier 1 supports `tables.list`, `tables.get`, `shared.list`, `shared.get` and all four `members.*` reads. `get` watches the whole table. Tier 2 supports `server.call` with `{handler,args}` and no mutation key; only queries are admitted. Handlers belong to the document's retained loaded version, so publishing a version without a handler does not remove it from an already loaded document. Optional `vector` and `revision` describe the snapshot the client actually received, not the last frame the server sent. Tier 2 resume revision checks ignore keys outside the loaded version's owned tables/stores, declared shared resources and declared `members:<companyId>` directory. `{type:'replace',sequence,subscriptions}` installs the full desired set and supersedes buffered deltas through that sequence; older replacements are refused. All requests also carry `patchId`, `versionId`, `documentId` and `generation`. A gap after 5 seconds or more than 64 buffered deltas sends `resync_required`. `admitted` names the last applied sequence. `snapshot` carries `id`, decimal query `revision`, `result` and a revision `vector` with resource keys, directory `members:<companyId>` keys and source lifecycle `patch:<id>` keys; `up-to-date` carries `id`, `revision` and `vector` when the result is unchanged or resume reaches an equal vector without running the query. Successful equal-vector checks emit no `re-run` event. `error` carries `id`, `permanent` and the structured runtime or handler `error`. A missing loaded handler, `handler_failed` or a result schema failure ends only that subscription, preserving its last browser value. Declared business errors retain their `source:'handler'`, `code` and `details`. Refusals inside handlers remain recoverable; losing document authority sends a stopping lifecycle notice instead. The host traces callback resources before access checks, canonicalising shared aliases to their owner. Successful runs replace dependencies even for equal results; failed runs retain previous and attempted resources so first-access refusals wake on reshare. Mid-run wakes are retained. Only resources actually read are watched. Member reads, when declared, are outside the company-database query snapshot. Mutations return committed resource revisions; render from the subscription rather than replaying a mutation result into its data. The newest subscription is refused at 64 per document, 256 per patch or 1024 per company; snapshots are at most 8 MiB. Re-runs occupy at most two slots per company and one per patch. Hosted query slots remain occupied until invocation resources settle, including after a timeout or document disconnect; `unknown_outcome` is retryable. Periodic durable reconciliation repairs missed wakes.

Request body: { patchId: string, versionId: string, documentId: string, generation: string, sequence: integer, type: "subscribe", subscription: { id: string, op: "tables.list" | "tables.get" | "shared.list" | "shared.get" | "members.list" | "members.search" | "members.get" | "members.getMany" | "server.call", args: { [key: string]: unknown }, vector?: { [key: string]: string }, revision?: string } } | { patchId: string, versionId: string, documentId: string, generation: string, sequence: integer, type: "unsubscribe", id: string } | { patchId: string, versionId: string, documentId: string, generation: string, sequence: integer, type: "replace", subscriptions: { id: string, op: "tables.list" | "tables.get" | "shared.list" | "shared.get" | "members.list" | "members.search" | "members.get" | "members.getMany" | "server.call", args: { [key: string]: unknown }, vector?: { [key: string]: string }, revision?: string }[] }

Responses:

- `200` { ok: true }
- `400` [RuntimeFailure](#runtimefailure)
- `401` [RuntimeFailure_1](#runtimefailure_1)
- `403` [RuntimeFailure_2](#runtimefailure_2)
- `404` [RuntimeFailure_3](#runtimefailure_3)
- `409` [RuntimeFailure_4](#runtimefailure_4)
- `413` [RuntimeFailure_5](#runtimefailure_5)
- `429` [RuntimeFailure_6](#runtimefailure_6)
- `503` [RuntimeFailure_7](#runtimefailure_7)
- `504` [RuntimeFailure_8](#runtimefailure_8)

## Version eligibility

The stream contract includes a reserved `revoked` frame, and the shell stops if it receives one. There is no version-revocation operation or persisted revocation state. Admission checks retained versions and the existing patch/session/access states. Who may revoke a version, how that appears and how it is undone remain open on [#425](https://github.com/allisonmahmood/patchy-cloud/issues/425). The frame is not evidence that version revocation is built.

## Private guest protocol

Wire 1 is pinned to workerd `1.20260924.1`, compatibility date `2026-09-24`.
The authoritative schemas are in [`packages/api/src/guest.ts`](../packages/api/src/guest.ts).
These are engine/inspection contracts, not public `HttpApi` routes or CLI operations.

- `BundleBinding`: company, patch and version ids plus lowercase SHA-256. `Bundle` adds the closed ESM source.
- `BindRequest`: wire and bundle. `BindReply` acknowledges the binding with `ok: true` or returns a typed binding refusal.
- `Invoke`: wire, binding, invocation id, attempt id, process generation, absolute deadline, handler, JSON arguments, initiating viewer and issuing-host callback address/capability.
- `InvokeReply`: an engine-owned `outcome` plus guest elapsed milliseconds. `returned` carries an untrusted guest `reply`; `deadline` means expired before dispatch; `guest_failed` means execution or reply decoding failed. Late returns remain guest data. Only the host classifies transaction settlement and verifies guest-claimed platform refusals against its own attempt records, preserving the recorded HTTP status rather than trusting a guest-supplied status.
- `GuestRequest`: describe or invoke. Description yields handler descriptors; invocation yields the existing `RuntimeReply` envelope without wrapping successful business data.
- `Callback`: runtime operation, arguments and optional raw file body. `CallbackReply` preserves runtime refusals or returns JSON/file bytes. File bodies carry `Uint8Array` bytes and a content type over RPC, not JSON byte arrays.
- Host callback transport uses JSON except binary requests marked by `X-Patchy-Callback`, whose value is URI-encoded operation metadata. `Content-Type` carries the file media type. Binary replies use `X-Patchy-File-Body: 1` with the same media-type convention. Authorization is the private per-attempt bearer, never a guest field.
- File callback bodies enforce `tier2.callbacks.fileBytes` and return `too_large` with limit id, scope and value. Callback deadline expiry returns `timeout`; transport or malformed replies return `source_unavailable`. Neither classifies commit or promises a safe retry.
- Staged uploads use raw `PUT /api/runtime/staged-files/:patchId/:versionId` with a claimed Content-Type and return `{ ok: true, value: { token, size, contentType } }`. `files.discard { upload }` uses the public JSON runtime route. Both are tier-2 shell-only, bound to viewer/patch/loaded version and unlogged. Each stage is at most 20 MiB; outstanding limits are 16 stages and 100 MiB per viewer per patch and 1 GiB per company by default. Quota refusals carry the applicable limit id, scope and value.
- `t.upload()` is action-arguments-only. The SDK resolves each argument with private action-only `files.inspectUpload { upload }` before application code runs, replacing supplied metadata with stored measured size and claimed content type. It is not a public operation. Adoption uses JSON callback `files.put { store, name, upload }`, has no byte body, and logs the existing file mutation. The public JSON route still refuses files.put. Adoption and discard serialize on the stage row, and consumed, discarded, expired or differently bound uploads return not_found. Uploads expire after one hour; an object id is never authority. Adoption writes a pointer without copying bytes. A subsequent failed mutation leaves the adopted file intact.
- The private host `/callback` listener is separate from the public API and accepts only a replica-local invocation capability. `X-Patchy-Invocation-Id`, `X-Patchy-Attempt-Id` and `X-Patchy-Process-Generation` must match its immutable attempt. Ended references answer `access_denied` with the end reason for five minutes; an old attempt never gains a later attempt's authority.
- The host enforces handler-kind rules and resolves the effective principal per callback: the patch for owned resources, the live initiating viewer for shared resources, connections and members. Viewer callbacks trust the admitted JWT until its expiry, then share one backend check of its Clerk session id and subject for the rest of that invocation, including concurrent callers and failed results. The cache never crosses invocations. Every authorized callback still reloads database membership, role and deactivation without changing user or company. It allows 1,000 callbacks per invocation, queues above eight outstanding, and bounds request/reply bytes to 64 MiB per call tree. `log` callbacks accept `{ message, details? }` within 32 KiB per invocation.
- Return, deadline, supersession and process kill fence callbacks. Resource cancellation continues after the caller disconnects; unresolved resources are destroyed at the five-second cleanup bound. Mutation transactions classify acknowledged commit or rollback and reconcile uncertain commits by key. An abnormal action fence after an effect began can remain `unknown_outcome`, including an earlier completed autocommit. Fiber interruption alone is not confirmed non-commit. Callback writes and integration calls carry `invocation_id` and `effective_principal` in their operation rows.
- Required pre-dispatch journal writes share the action/mutation deadline; no handler runs before its row is confirmed. Settlement journal writes share the absolute deadline plus cleanup bound and cannot retain action slots indefinitely. When the journal is unavailable, overdue pending invocation and operation rows read as unknown while stored evidence remains available for reconciliation.
- Queries with declared company resources use one read-only `REPEATABLE READ` transaction across callbacks, with the declared resources' revision vector captured as the commit watermark before reads. Resource-free queries retain their callback lifetime without acquiring or provisioning company storage; their watermark is empty and database-held time is zero. Acquisition consumes the three-second deadline; deadline fencing starts protocol cancellation, followed by confirmed release or destruction within cleanup. Shared-table authority is checked live outside the data snapshot on every callback. Query files expose `files.list` and `files.stat` metadata; file bytes and connections are refused by the kind rule.
- Mutations run callback jobs on one host-owned SERIALIZABLE company transaction, opened on the first database callback or at result commit for a callback-free handler. Table callbacks reuse its connection and savepoints. Completion refuses queued callbacks before validated-result commit. A `40001` makes the attempt abort-only and re-invokes the entire handler up to three times within the original five-second deadline; exhaustion is `write_conflict` with `limitId: tier2.mutation.attempts`, the enforced value and viewer scope. Only the transaction owner announces written resources after commit, after releasing its company lease. Wake delivery is bounded and does not delay or change an acknowledged successful reply. Mutation success carries the committed revision vector.
- The mutation key, binding, originating invocation, argument fingerprint and result commit with the writes. An in-window key with no visible committed result may execute. Key-specific `23505` at insert or commit rolls back the loser before resolving the winner; unrelated uniqueness failures never deduplicate. Keys expire at 24 hours and reject more than five minutes of future skew. Changed patch, handler, version, viewer or arguments are refused. A resolved COMMIT on an aborted transaction is rollback, not success; uncertain commit stays `unknown_outcome`. Later key replay reconciles the originating invocation when stored commit evidence becomes available, preserving its original metering and reply-delivery record.
- Actions have a sixty-second deadline and no surrounding transaction. They read shared tables, transfer plain file bytes, and call declared integrations as the viewer with live access checks and a fifteen-second per-call deadline. `ctx.run` uses `server.call` callbacks to sibling queries and mutations; action targets are refused. Each child has its own invocation row and parent link, shares the tree byte budget, and keeps the parent's exact binding with a deadline no later than the parent's. Nested mutations have host-minted keys and independent transactions; their connection time contributes to the parent's `db_ms`.
- `server.call` arguments are at most one MiB; mutation results at most 64 KiB and query/action results at most eight MiB. Result schema failures and oversized results are `handler_failed`. A lost query reply is retried once by the client, using handler kinds supplied by the loaded shell's nonce-bound bootstrap. In dev, trusted stream `handlers` frames replace those kinds after a server rebind and on reconnect, without reloading the document. Mutation `unknown_outcome` offers explicit `retry()` with the same key and captured arguments; new calls mint fresh keys from stream `hello.serverTime`. Actions and unknown kinds are never replayed.
- `InspectRequest`: wire and source only. `InspectionReply` contains descriptors or a runtime refusal. Inspection has no company binding, capability or callback path and runs in a reaped, deadline-bounded process.

See [ADR-0012](./adr/ADR-0012-credential-free-execution-service.md) for authority, lifetime and hosting contracts. Dev and test can use the local executor; production tier 2 admission requires the built ECS provider (`EXECUTION_PROVIDER=ecs`). Its role-only Fargate acceptance remains pending an IAM grant on [#406](https://github.com/allisonmahmood/patchy-cloud/issues/406) and [PR #439](https://github.com/allisonmahmood/patchy-cloud/pull/439). Production infrastructure [#415](https://github.com/allisonmahmood/patchy-cloud/issues/415) and first deploy [#416](https://github.com/allisonmahmood/patchy-cloud/issues/416) remain unbuilt.

## Private execution management protocol

The schemas in [`packages/api/src/management.ts`](../packages/api/src/management.ts) are private host-to-supervisor operations, never public `HttpApi` routes or CLI commands. All four routes use POST and authenticate the current or previous deployment secret as a bearer before reading JSON. Invocation capabilities are refused. The listener binds loopback or an explicitly configured private interface; deployment security groups restrict access to hosts.

- `/bind` takes `companyId`, `bindingEpoch` and an optional guest `Bundle`. The first call reserves the company. Retrying a bundle bind at the same epoch is idempotent while its resident process is alive; rebinding after reap creates a new generation. Adoption raises the epoch. A bundle bind returns `bindingEpoch`, `binding` and `processGeneration`. Another company or a stopped task cannot reuse it. Unfinished initialization expires at `execution.process.idle` (60 seconds by default), even while health probes succeed, with a `load_failed` refusal and process-report end cause.
- Bind may also carry `operatingLimits` and `configRevision` together. The controller sends the resolved probe interval, process RSS, process idle, resident process count and aggregate bytes for the company. The supervisor applies them under the binding owner check, including on an idempotent bind, and ignores an older override revision at the same epoch. Probe intervals must remain below the six-second stall bound. Guests cannot configure these values.
- Bind may carry `callbackUrls`, up to 64 private IPv4 HTTP `/callback` addresses with explicit ports. An authenticated host registers its issuing address under the binding epoch check. Registrations last for the task's lifetime, so old and replacement hosts can use an already-loaded process during a rollout. Workerd still sees only one loopback proxy; the supervisor selects the target from its immutable invocation record, never guest input.
- `/invoke` takes `bindingEpoch` and the guest `Invoke` as `request`, including the generation returned by bind. Admission can evict idle siblings under residency pressure, never the target process; without enough capacity it refuses `busy`. Success is the guest `InvokeReply`; a killed process returns `process_killed`, not a transaction outcome. The caller must not replay automatically.
- `/stop` takes `bindingEpoch` and optional `processGeneration`, returning 204. With a generation it kills only that process; without one it permanently stops the supervisor's admissions and reaps all processes. `/stats` remains available for reports.
- `/stats` takes `bindingEpoch` and optional `acknowledgeReports` ids. It returns company, epoch, stopped state, aggregate RSS, live process statistics and unacknowledged process reports. The host must persist reports before acknowledging them. Retried stats replies retain the same report ids.
- A process report includes its binding, epoch, generation, spawn/end times, end cause, CPU seconds, peak RSS, calls served, interrupted attempt identities and process wide event. Residency peaks cover that process's lifetime, not earlier residents. The supervisor samples meters before reap. An unexpected sampling failure kills only the affected resident with end cause `metering_failed`, leaving other residents supervised. Only the host classifies each interrupted attempt by its commit outcome.
- Callback forwarding stamps `X-Patchy-Binding-Epoch`, `X-Patchy-Process-Generation`, `X-Patchy-Invocation-Id` and `X-Patchy-Attempt-Id`. The supervisor rejects ended attempts and killed generations before forwarding, independently of the host's capability checks.
- Refusals are `{ ok: false, code }`, with `scope`, `limitId` and the enforced `value` for limit refusals (`retryAfter` only where safe). Authentication returns 401; stale epochs/generations, missing bundles, binding conflicts and stopped tasks return 409; residency pressure returns 503 `busy`; process loss returns 502 `process_killed`. Malformed requests and `load_failed` return 400. Private request bytes are bounded by `execution.management.bodyBytes`; oversized bodies return 413 `too_large` with the enforced limit.

Residency `busy` refusals also carry `limits`, an array of observed
`{ limitId, value, peak, configRevision: { deploymentRevision, overrideRevision } }`.
The host retains these supervisor measurements in its request event rather than
substituting the host's limit configuration.

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

### HandlerSchema

```
{ kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json", optional?: true } | { kind: "object", fields: { [key: string]: HandlerSchema }, optional?: true } | { kind: "array", element: HandlerSchema, optional?: true } | { kind: "enum", values: string[], optional?: true } | { kind: "nullable", value: HandlerSchema, optional?: true } | { kind: "row", table: string, optional?: true } | { kind: "fileHandle" | "upload", optional?: true }
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
    tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "member", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } },
    files: { [key: string]: { description: string, shared?: boolean } },
    uses: { [key: string]: { kind: "postgres", handle: string, id: string, revision: integer } | { kind: "sharedTable", patchId: string, table: string, id: string, revision: integer } | { kind: "sharedStore", patchId: string, store: string, id: string, revision: integer } | { kind: "members" } },
    handlers?: { [key: string]: { kind: "query" | "mutation" | "action", args: { [key: string]: HandlerSchema }, result: HandlerSchema, errors?: string[] } },
    sdkImports?: string[]
  },
  html: string,
  server?: string,
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
  artifacts: {
    html: {
      sha256: string,
      bytes: integer
    },
    server?: {
      sha256: string,
      bytes: integer
    }
  },
  handlers?: { name: string, kind: "query" | "mutation" | "action" }[],
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
  artifacts: {
    html: {
      sha256: string,
      bytes: integer
    },
    server?: {
      sha256: string,
      bytes: integer
    }
  },
  handlers?: { name: string, kind: "query" | "mutation" | "action" }[],
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
  inventory: { tables: { name: string, description: string, shared: boolean, declarable: boolean, reason?: "not_shared" | "source_off", hint?: string }[], stores: { name: string, description: string, shared: boolean, declarable: boolean, reason?: "not_shared" | "source_off", hint?: string }[] } | null,
  reads: ({ alias: string, patchId: string, name?: string, table: string, state: "live" | "retired" | "deleted" | "gone" } | { alias: string, patchId: string, name?: string, store: string, state: "live" | "retired" | "deleted" | "gone" })[]
}
```

### PrimitiveDetail

```
{
  kind: "table" | "store",
  name: string,
  description: string,
  shared: boolean,
  declarable: boolean,
  reason?: "not_shared" | "source_off",
  hint?: string,
  schemaRevision: integer,
  columns: { name: string, kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json" | "ref" | "member", optional: boolean, default?: unknown, ref?: string }[],
  indexes: { name: string, columns: string[], unique: boolean }[]
}
```

### PatchInventory

```
{
  schemaRevision: integer,
  tables: { [key: string]: { description: string, columns: { [key: string]: { kind: "text", optional?: boolean, default?: string } | { kind: "integer", optional?: boolean, default?: integer } | { kind: "number", optional?: boolean, default?: number } | { kind: "boolean", optional?: boolean, default?: boolean } | { kind: "timestamp", optional?: boolean, default?: "now" | string } | { kind: "json", optional?: boolean, default?: unknown } | { kind: "member", optional?: boolean, default?: unknown } | { kind: "ref", table: string, optional?: boolean, default?: string } }, indexes: { [key: string]: { columns: string[], unique?: boolean } }, shared?: boolean } },
  files: { [key: string]: { description: string, shared?: boolean } }
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
  wireVersion: integer,
  toolchain: {
    vite: {
      testedAgainst: string,
      accepted: string
    },
    vite-plugin-singlefile: {
      testedAgainst: string,
      accepted: string
    },
    typescript: {
      testedAgainst: string,
      accepted: string
    },
    @types/node: {
      testedAgainst: string,
      accepted: string
    }
  }
}
```

### RuntimePrincipal

```
{ userId: string } | null
```

### RuntimeCall

```
{ patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.list", args: { connection: string, relation: { schema: string, name: string }, eq?: { [key: string]: string | number | boolean | null }, range?: { column: string, gt?: string | number | boolean | null, gte?: string | number | boolean | null, lt?: string | number | boolean | null, lte?: string | number | boolean | null }, orderBy?: { column: string, direction: "asc" | "desc" }, select?: string[], limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.get", args: { connection: string, relation: { schema: string, name: string }, key: { [key: string]: string | number | boolean | null } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.getMany", args: { connection: string, relation: { schema: string, name: string }, keys: { [key: string]: string | number | boolean | null }[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "postgres.query", args: { connection: string, sql: string, params: ((string | number | boolean | null) | (string | number | boolean | null)[])[], shape: { [key: string]: { kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json", optional?: boolean } } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "server.call", args: { handler: string, args: { [key: string]: unknown }, mutationKey?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "me", args: {} } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "members.list", args: { cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "members.search", args: { text: string, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "members.get", args: { id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "members.getMany", args: { ids: string[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.get", args: { table: string, id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.getMany", args: { table: string, ids: string[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.list", args: { table: string, index?: string, eq?: { [key: string]: unknown }, range?: { column: string, gt?: unknown, gte?: unknown, lt?: unknown, lte?: unknown }, order?: "asc" | "desc", limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.get", args: { alias: string, id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.getMany", args: { alias: string, ids: string[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.list", args: { alias: string, index?: string, eq?: { [key: string]: unknown }, range?: { column: string, gt?: unknown, gte?: unknown, lt?: unknown, lte?: unknown }, order?: "asc" | "desc", limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.insert", args: { table: string, row: { [key: string]: unknown } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.insertMany", args: { table: string, rows: { [key: string]: unknown }[] } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.update", args: { table: string, id: string, patch: { [key: string]: unknown } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "tables.delete", args: { table: string, id: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.put", args: { store: string, name: string, contentType: string } | { store: string, name: string, upload: { token: string, size: integer, contentType: string } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.stage", args: { contentType: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.discard", args: { upload: { token: string, size: integer, contentType: string } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.inspectUpload", args: { upload: { token: string, size: integer, contentType: string } } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.get", args: { store: string, name: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.redeem", args: { handle: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.list", args: { store: string, prefix?: string, limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.stat", args: { store: string, name: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.files.get", args: { alias: string, name: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.files.list", args: { alias: string, prefix?: string, limit?: integer, cursor?: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "shared.files.stat", args: { alias: string, name: string } } | { patchId: string, versionId: string, principal: RuntimePrincipal, wire: integer, op: "files.delete", args: { store: string, name: string } }
```

### RuntimeSuccess

```
{
  ok: true,
  value: unknown,
  revisions?: { [key: string]: string }
}
```

### HandlerFailure

```
{
  ok: false,
  source: "handler",
  code: string,
  details?: unknown
}
```

### ServerCallReply

```
RuntimeSuccess | HandlerFailure
```

### RuntimeCode

```
"connection_not_declared" | "access_denied" | "invalid_request" | "timeout" | "too_large" | "source_unavailable" | "table_not_declared" | "row_not_found" | "not_found" | "invalid_row" | "unique_violation" | "invalid_cursor" | "not_additive" | "relation_unknown" | "invalid_query" | "shape_mismatch" | "session_expired" | "session_refresh_required" | "principal_changed" | "not_available_on_public" | "shell_outdated" | "unknown_outcome" | "rate_limited" | "too_many_requests" | "busy" | "handler_failed" | "handler_timeout" | "write_conflict" | "patch_paused" | "server_required" | "tier2_not_public" | "limit_exceeded" | "offset_exhausted"
```

### RuntimeFailure

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_1

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_2

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_3

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_4

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_5

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_6

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_7

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeFailure_8

```
{
  ok: false,
  source: "patchy",
  error: string,
  code: RuntimeCode,
  scope?: "viewer" | "patch" | "company" | "host",
  limitId?: string,
  value?: number,
  retryAfter?: number,
  details?: { [key: string]: unknown },
  correlationId?: string
}
```

### RuntimeStreamFrame

```
{ type: "hello", generation: string, serverTime: number } | { type: "served", versionId: string, tier: integer } | { type: "handlers", kinds: { [key: string]: unknown } } | { type: "snapshot", id: string, revision: string, result: unknown, vector: { [key: string]: string } } | { type: "up-to-date", id: string, revision: string, vector: { [key: string]: string } } | { type: "admitted", sequence: integer } | { type: "resync_required", sequence: integer } | { type: "error", id: string, permanent: boolean, error: RuntimeFailure | HandlerFailure } | { type: "revoked" } | { type: "session_expired" } | { type: "access_denied" } | { type: "principal_changed" } | { type: "starting" } | { type: "ready" } | { type: "start_failed", code: "busy", scope?: "viewer" | "patch" | "company" | "host", limitId?: string, value?: number, retryAfter: number } | { type: "closed", reason: "slow_consumer" | "replaced" }
```
