/**
 * The `/api/*` contract: auth, patches, browser runtime and public release discovery.
 * Request, success and error shapes come from the API's schema modules. The server
 * implements it and the CLI's client is derived from it; neither side
 * re-types a wire shape by hand. The route descriptions here are the text of
 * `docs/API.md`.
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import {
  BadRequest,
  Conflict,
  DeviceLoginGone,
  DeviceLoginPoll,
  DeviceLoginStarted,
  Identity,
  InvalidHtml,
  LoggedOut,
  NotFound,
  NameTaken,
  NotAdditive,
  PatchInventory,
  PublishUnavailable,
  Ok,
  PatchQuotaExceeded,
  PayloadTooLarge,
  PollDeviceLoginRequest,
  RateLimited,
  RequestTargetTooLong,
  Shared,
  ShareRequest,
  StartDeviceLoginRequest,
  Unauthorized,
  PublishCreated,
  PublishRequest,
  PublishUpdated,
  PublishRefused,
  PublishKeyConflict,
  Release,
  Catalog,
  GenerateRequest,
  Generated
} from "./schemas.js";
import { RuntimeBytes, RuntimeCall, RuntimeFailure, RuntimeSuccess } from "./runtime.js";

/** The identity a valid bearer token resolves to, provided to every protected handler. */
export class CurrentIdentity extends Context.Service<CurrentIdentity, Identity>()(
  "@patchy/api/api/CurrentIdentity"
) {}

/**
 * Bearer auth for every protected route. A missing credential and a bad one
 * answer the same 401, so the wire never says which.
 */
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentIdentity; requires: never }
>()("@patchy/api/api/Authorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

/**
 * What any protected route can answer before its handler runs: the request
 * target was malformed, a per-minute bucket ran dry, or the route is not there.
 */
const protectedErrors = [BadRequest, NotFound, RateLimited] as const;

/**
 * The routes that take a patch id in the path also answer 414 to an overlong
 * one. The id is a plain string here on purpose: an unknown or malformed id
 * is a 404 from the handler, not a 400 from the path.
 */
const patchRouteErrors = [...protectedErrors, RequestTargetTooLong] as const;
const patchParams = { patchId: Schema.String };

/** The route's paragraph in `docs/API.md`. */
const describe = (description: string) => OpenApi.annotations({ description });

export class AuthGroup extends HttpApiGroup.make("auth", { topLevel: true })
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: Identity,
      error: protectedErrors
    })
      .middleware(Authorization)
      .annotateMerge(describe("Who the bearer acts as: the user, company, role and machine.")),
    HttpApiEndpoint.post("logout", "/logout", {
      success: LoggedOut,
      error: protectedErrors
    })
      .middleware(Authorization)
      .annotateMerge(
        describe(
          "Revoke the bearer itself. A concurrent revocation is reported as `alreadyRevoked`."
        )
      ),
    HttpApiEndpoint.post("startDeviceLogin", "/login/device", {
      payload: StartDeviceLoginRequest,
      success: DeviceLoginStarted,
      error: [BadRequest, RateLimited, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Begin a device login without a bearer token. Relay `verificationUrl` and `userCode` to " +
          "the person, who confirms the code in their signed-in browser; the code is never typed. " +
          "The login expires after ten minutes. Starts are limited per source address " +
          "(`PATCHY_DEVICE_LOGIN_RATE_LIMIT_PER_MINUTE`, default 5). On a re-login, send the " +
          "stored machine token's id as `previousMachineTokenId`; the old key stays live until " +
          "the completing poll replaces it, and only when it belongs to the confirming user. " +
          "The JSON body is limited to 4096 bytes: a declared overflow answers 413; " +
          "overflow while streaming aborts the connection before parsing."
      )
    ),
    HttpApiEndpoint.post("pollDeviceLogin", "/login/device/token", {
      payload: PollDeviceLoginRequest,
      success: DeviceLoginPoll,
      error: [BadRequest, DeviceLoginGone, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Poll without a bearer token, at the returned interval. A poll made too soon answers " +
          "`slow_down`; add five seconds to the interval. After browser confirmation, one poll " +
          "mints the machine token and returns `complete`, including the confirming user's email " +
          "and company handle and name in the same response. The key expires in 90 days or after " +
          "30 idle days. Complete, expired and denied logins are deleted, so a subsequent poll " +
          "answers 410 `unknown`. Plaintext tokens are never stored. The JSON body is limited " +
          "to 4096 bytes: a declared overflow answers 413; overflow while streaming aborts " +
          "the connection before parsing."
      )
    )
  )
  .prefix("/api") {}

export class PatchesGroup extends HttpApiGroup.make("patches", { topLevel: true })
  .add(
    HttpApiEndpoint.post("publish", "/publish", {
      payload: PublishRequest,
      success: [PublishCreated, PublishUpdated],
      error: [
        PatchQuotaExceeded,
        ...protectedErrors,
        InvalidHtml,
        PublishKeyConflict,
        NameTaken,
        NotAdditive,
        PublishUnavailable,
        Conflict,
        PayloadTooLarge,
        PublishRefused
      ]
    }).annotateMerge(
      describe(
        "Publish one HTML bundle and its manifest. Without `patchId` creates a patch (201); " +
          "with an owned `patchId` publishes a version (200). Authenticate, then replay by owner " +
          "and `publishKey` before limits or release validation: identical payloads return the " +
          "stored response and status, even after an upgrade; changed payloads answer 409 " +
          "`publish_key_conflict`. New attempts require the exact current release and manifest " +
          "version from `GET /api/release`. Tier 0 may define tables and file stores, provisioned additively; " +
          "higher tiers answer `tier_mismatch`. " +
          'Postgres uses carry `{ kind: "postgres", handle, id, revision }`, keyed by alias. ' +
          "The handle and id must name the same connected company connection, otherwise " +
          "`connection_not_connected`; the revision must equal its current schema snapshot, " +
          "otherwise `stale_generated` (run `patchy refresh`). Credential rotation and retargeting " +
          "preserve the connection id. Postgres runtime calls retain the version's recorded snapshot. " +
          'Shared-table uses carry `{ kind: "sharedTable", patchId, table, id, revision }`, keyed by alias. ' +
          "The resolved id is `<patchId>/<table>`, never a patch name; revision stamps the source inventory. " +
          "Publish requires a live same-company source the publisher can open and an inventory table " +
          "marked shared, otherwise `patch_not_openable`. A stamp behind the source revision warns, " +
          "not refuses. Unsharing a defined table reports the number of distinct live declaring patches, " +
          "including declarations in retained versions; omission and rollback never change sharing. " +
          "Schema changes are checked before bytes and rechecked under the patch lock. " +
          "Preflight conservatively refuses new indexes with existing uncompressed key tuples " +
          "over 2,000 bytes, and added columns that expand existing rows over the row limit. " +
          "`not_additive` names every refused object, change and fix. Omitted tables and stores remain in " +
          "the cumulative inventory with their data and appear as `unused`; a required column cannot be omitted. " +
          "The schema revision advances only when provisioning changes something, never for a new bundle alone. " +
          "File mode (empty definitions and no repo name, or file metadata) onto cumulative inventory " +
          "answers `has_primitives`; an empty named repo manifest may omit all tables. " +
          "Reports and schema revision are persisted for replay. " +
          "Tier 0 HTML passes the safe-HTML policy. Creates spend the per-token create limit " +
          "and live-patch quota; updates do not. Omitted scope defaults to company on creates " +
          "and remains unchanged on updates. `manifest.name` is an exact company-scoped name " +
          "(3–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit); " +
          "a taken current name answers 409 `name_taken` on create or rename. Without a name, " +
          "creates derive one from `metadata.filename` without its extension (title when absent), " +
          "normalize it, fall back to `patch` and add `-2`, `-3`, etc. on collision. Updates with " +
          "no name retain their existing name. Rename leaves a redirect until another patch " +
          "claims it; deletion frees all names. `address` and `publicUrl` both name the absolute " +
          "`/<company>/<name>` address. The JSON body cap is three times the HTML cap."
      )
    ),
    HttpApiEndpoint.get("inventory", "/patches/:patchId/inventory", {
      params: patchParams,
      success: PatchInventory,
      error: [...patchRouteErrors, PublishUnavailable]
    }).annotateMerge(
      describe(
        "Read the cumulative table and file-store definitions and schema revision for an owned, " +
          "available patch. Omitted definitions remain here. Unknown, unavailable and another " +
          "user's patches all answer 404. A primitive-free patch answers empty definitions and revision zero. " +
          "An existing ready company database is probed for inventory even when the current version " +
          "declares none: a failed platform commit may have left cumulative definitions. An unavailable " +
          "database answers `source_unavailable` (or `busy`), never a fabricated empty inventory."
      )
    ),
    HttpApiEndpoint.post("share", "/patches/:patchId/share", {
      params: patchParams,
      payload: ShareRequest,
      success: Shared,
      error: [...patchRouteErrors, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Change the sharing scope of a patch owned by the bearer token's user, without publishing a version. " +
          "`company` requires a company member's browser session; `public` lets anyone with the link open the current version. " +
          "Only the current version of a public patch is public; older versions stay behind the company door. " +
          "A patch the caller does not own answers 404. The current public version may be cached for 60 seconds " +
          "at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>`; older versions and company patches are " +
          "`private, no-store` and answer 401 without a session. " +
          "The JSON body is bounded by the publish body limit: three times " +
          "`PATCHY_MAX_HTML_BYTES`. An oversized declared body answers 413; " +
          "streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged."
      )
    ),
    HttpApiEndpoint.delete("delete", "/patches/:patchId", {
      params: patchParams,
      success: Ok,
      error: patchRouteErrors
    }).annotateMerge(
      describe(
        "Delete a patch owned by the bearer token's user. The origin stops serving it at once; " +
          "all its names are freed, and the expiry sweep removes its content after its retention clock expires."
      )
    )
  )
  .middleware(Authorization)
  .prefix("/api") {}

/** A bare ?all is true; generated clients encode booleans as true/false. */
const catalogAll = Schema.Literals(["", "true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== "false"),
    encode: SchemaGetter.transform((value) => (value ? ("true" as const) : ("false" as const)))
  })
);

export class SdkGroup extends HttpApiGroup.make("sdk", { topLevel: true })
  .add(
    HttpApiEndpoint.get("release", "/release", { success: Release }).annotateMerge(
      describe(
        "The current tooling release and its manifest and wire versions. Unauthenticated. " +
          "GET /sdk/patchy-<release>.tgz serves this release's tarball without authentication " +
          "with Cache-Control: public, max-age=31536000, immutable; integrity is its sha512 " +
          "Subresource Integrity digest. Discovery is no-store; only the exact GET tarball path is reserved."
      )
    ),
    HttpApiEndpoint.get("catalog", "/sdk/catalog", {
      query: Schema.Struct({ all: Schema.optionalKey(catalogAll) }),
      success: Catalog,
      error: [PublishUnavailable, ...protectedErrors]
    })
      .middleware(Authorization)
      .annotateMerge(
        describe(
          "Company metadata only: connected Postgres connections and live same-company shared tables. " +
            "With all=true, include disconnected connections and every offered integration's connected state. " +
            "Never returns credentials or business rows. Responses are private, no-store."
        )
      ),
    HttpApiEndpoint.post("generate", "/sdk/generate", {
      payload: GenerateRequest,
      success: Generated,
      error: [PublishRefused, PublishUnavailable, ...protectedErrors]
    })
      .middleware(Authorization)
      .annotateMerge(
        describe(
          "Resolve declarations against current company metadata and return finished managed files and uses stamps. " +
            "Requires the exact current release. Refuses connection_not_connected, patch_not_openable and release_mismatch. " +
            "Present skills are sticky; an unknown present skill refuses generation. Includes core and implied skills, " +
            "typed clients, contexts and fixture stubs, never manifest.json, credentials or business rows."
        )
      )
  )
  .prefix("/api") {}

/**
 * Raw handlers choose an explicit HTTP status when encoding RuntimeFailure:
 * the identical wire shape at each status cannot select its own status.
 */
const runtimeErrors = [400, 401, 403, 409, 413, 429, 503, 504].map((status) =>
  RuntimeFailure.pipe(HttpApiSchema.status(status))
);

/**
 * handleRaw bypasses payload decoding, not header/param decoding. Keep these
 * permissive so admission returns runtime failures, never generic schema errors.
 */
const runtimeHeaders = {
  "x-patchy-wire": Schema.optionalKey(Schema.String),
  "x-patchy-principal": Schema.optionalKey(Schema.String),
  cookie: Schema.optionalKey(Schema.String),
  authorization: Schema.optionalKey(Schema.String),
  "content-length": Schema.optionalKey(Schema.String)
};
const runtimeFileParams = {
  patchId: Schema.String,
  versionId: Schema.String,
  store: Schema.String,
  "*": Schema.String
};
const runtimeAdmission =
  "Browser-only: no bearer middleware, and machine tokens are refused. Every request requires " +
  "`X-Patchy-Wire` (the decimal wire version) and `X-Patchy-Principal` (JSON `null` or " +
  '`{"userId":"..."}`). Admission resolves the loaded patch/version before validating an operation. ' +
  "A public version answers `me` with null and every other operation, including unknown ones, " +
  "with `not_available_on_public`, with or without a session and before any principal check. " +
  "Public shells always send a null principal. Company versions require a browser session " +
  "(`session_expired`), a viewer who can open the patch (`access_denied`), and a principal " +
  "matching that session's user (`principal_changed`); only `me` may bootstrap with null. " +
  "Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls " +
  "are limited to 300 per minute by default; `rate_limited` is 429 with `Retry-After` seconds. " +
  "Responses, including failures, are `Cache-Control: no-store`. ";
const runtimeFileContract =
  "The trailing `*` is the file name, not an object URL. Encode the full name with " +
  "`encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. " +
  "The wildcard also accepts slash-separated segments and avoids the router's 100-character " +
  "named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; " +
  "`store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters " +
  "or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded " +
  "manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or " +
  "base64; the byte limit is 20 MiB (`PATCHY_RUNTIME_FILE_BYTES`), enforced against actual streamed " +
  "bytes. Invalid names, undeclared stores and missing files answer `invalid_request`. Each PUT " +
  "writes a fresh immutable object and changes the index only after the byte write succeeds. " +
  "Files belong to the patch and store, never a version; rollback and version cleanup preserve them. ";

export class RuntimeGroup extends HttpApiGroup.make("runtime", { topLevel: true })
  .add(
    HttpApiEndpoint.post("call", "/runtime/call", {
      headers: { ...runtimeHeaders, origin: Schema.optionalKey(Schema.String) },
      payload: RuntimeCall,
      success: RuntimeSuccess,
      error: runtimeErrors
    }).annotateMerge(
      describe(
        runtimeAdmission +
          "The JSON envelope is `{ patchId, versionId, principal, wire, op, args }`; its principal " +
          "and wire must match the required headers. Mutating and integration operations require " +
          "the exact shell `Origin` (scheme, host and port); a cross-site or missing Origin is " +
          "refused before execution. `me` with `args: {}` returns " +
          "`{ ok: true, value: { user: { id, name, email }, company: { id, handle, name }, admin } }` " +
          "on company versions, or `{ ok: true, value: null }` on public versions; `admin` is a UI " +
          "hint, not additional authority. The seven `tables.*` operations resolve tables and validate " +
          "rows against the loaded version's manifest, not the newest version. `get` returns a row " +
          "or null; `getMany` preserves input order and nulls; `insert`, `insertMany` and `update` " +
          "return their rows; `delete` returns null, including for a missing row. `update` of a " +
          "missing row is `row_not_found`. Defaults apply to omitted insert fields, optional fields " +
          "accept null, and explicit null for a defaulted field is `invalid_row`. " +
          "`list { table, index?, eq?, range?, order?, limit?, cursor? }` returns `{ rows, cursor }`. " +
          "The default index is `(createdAt, id)`; `eq` constrains leading index columns, one " +
          "`range { column, gt?, gte?, lt?, lte? }` constrains the next column, and `order` is " +
          "`asc` or `desc` with an id tie-breaker. Keyset cursors are bound to table, index, " +
          "filters and order. The page defaults to 100 rows and is capped at 1,000; `getMany` and " +
          "`insertMany` are capped at 1,000 items and 8 MiB, individual rows at 1 MiB. List and " +
          "getMany results are capped at 8 MiB, checking database JSON transport before decoding " +
          "and final wire bytes afterward. Transport whitespace can make its check stricter. " +
          "Native PostgreSQL B-tree key-size failures are `too_large`; publishing a non-unique " +
          "index adds no separate size CHECK constraint or 2,000-byte runtime write limit. " +
          "`shared.get { alias, id }`, `shared.getMany { alias, ids }` and `shared.list { alias, ... }` " +
          "reuse those read contracts and source indexes, without writes. The alias resolves through " +
          "the loaded consumer manifest to a stable source patch id and table. Every call checks " +
          "source liveness, the viewer's same-company access and the inventory's shared flag; losing " +
          "any of them fails the entire call with `access_denied`, including an empty getMany. " +
          "While authorized, dangling ids remain null in input order. Source definitions come from " +
          "cumulative inventory, so omission from the source's active manifest does not remove access. " +
          "Deletion and recreation under the same patch name never rebind a declaration. " +
          "`postgres.list`, `postgres.get`, `postgres.getMany` and `postgres.query` select a " +
          "declared alias with `connection`; relation operations use `relation: { schema, name }`. " +
          "The alias resolves through the loaded manifest to its stable connection id and pinned " +
          "snapshot revision, with credentials and connected state checked live. Each operation " +
          "returns `value: { ok: true, rows }`; list additionally returns `cursor`. No rowCount or " +
          "truncated flag is returned. `get { key }` returns one row or null in rows; " +
          "`getMany { keys }` preserves input order and missing-row nulls. Both require a usable " +
          "source primary key. `list { eq?, range?, orderBy?, select?, limit?, cursor? }` quotes " +
          "all identifiers and projects supported columns explicitly. `orderBy` is `{ column, " +
          'direction: "asc" | "desc" }`, with primary-key tie breakers. Keyset cursors bind to ' +
          "connection, relation, snapshot, filters and order; unkeyed relations use offsets bounded " +
          "to 10,000 (`offset_exhausted`). Default page 100, maximum 1,000. " +
          "`query { sql, params, shape }` accepts scalar/null parameters and arrays of scalars. " +
          'Shape columns are `{ kind: "text" | "integer" | "number" | "boolean" | ' +
          '"timestamp" | "json", optional? }`; defaults and refs are refused. Missing or duplicate ' +
          "columns and nulls in required columns fail `shape_mismatch`; extras are dropped. " +
          "Integers must be safe; int8/numeric are strings, never silently rounded. " +
          "Queries execute as one extended-protocol statement in a read-only transaction with " +
          "a 10-second statement timeout and a 15-second deadline including queue wait. " +
          "Every result is bounded during collection to 1,000 rows and 8 MiB; overflow fails the " +
          "whole call. Pools allow four backends per connection, 64 per process and 60 seconds idle. " +
          "Postgres failures include `relation_unknown`, `invalid_query`, `shape_mismatch`, " +
          "`invalid_cursor`, `offset_exhausted` and integration boundary codes. `invalid_query` " +
          "details retain the source message, SQLSTATE and position. Integration attempts are " +
          "logged before execution, including denials and failures with trusted attribution; " +
          "only query logs SQL text (up to 8 KiB), never parameters. " +
          "Request bodies allow 1 MiB plus envelope for " +
          "insert/update and 8 MiB plus envelope for insertMany; Postgres calls allow 256 KiB " +
          "including parameters, and other calls 64 KiB. Overflow is `too_large` (413). Undeclared tables answer `table_not_declared`; " +
          "invalid fields/defaults answer `invalid_row`, uniqueness conflicts `unique_violation`, " +
          "and invalid pagination `invalid_cursor`. Unknown operations answer `invalid_request`. " +
          "Failures are `{ ok: false, error, code, details?, correlationId? }`; every table mutation is " +
          "logged before execution and logged failures carry their runtime-log correlation id. " +
          "Table and file reads are not logged. `files.list { store, prefix?, limit?, cursor? }` " +
          "returns `{ files: [{ name, size, contentType, updatedAt }], cursor }`, ordered by name " +
          "with a literal prefix and a keyset cursor bound to patch, store and prefix. Pages default " +
          "to 100, capped at 1,000 (`PATCHY_FILE_DEFAULT_PAGE`, `PATCHY_FILE_MAX_PAGE`), with an " +
          "8 MiB result cap (`PATCHY_RUNTIME_RESULT_BYTES`), including the cursor. " +
          "`files.delete { store, name }` removes only the index row and returns null idempotently. " +
          "File mutations log store/name as their resource. `files.put` and `files.get` require the " +
          "raw bytes routes; they are refused on this JSON route, never serialized as JSON/base64."
      )
    ),
    HttpApiEndpoint.put("putFile", "/runtime/files/:patchId/:versionId/:store/*", {
      params: runtimeFileParams,
      headers: {
        ...runtimeHeaders,
        origin: Schema.optionalKey(Schema.String),
        "content-type": Schema.optionalKey(Schema.String)
      },
      payload: RuntimeBytes,
      success: RuntimeSuccess,
      error: runtimeErrors
    }).annotateMerge(
      describe(
        runtimeAdmission +
          "PUT additionally requires the exact shell `Origin` (scheme, host and port). The " +
          "uploaded media type travels as `Content-Type`. Principal and wire travel only " +
          "in their required headers; the body contains only raw file bytes. " +
          runtimeFileContract +
          "An admitted PUT is logged before reading its body and answers `{ ok: true, value: null }` " +
          "with `no-store`. A failed or oversized upload preserves the previous file."
      )
    ),
    HttpApiEndpoint.get("getFile", "/runtime/files/:patchId/:versionId/:store/*", {
      params: runtimeFileParams,
      headers: {
        ...runtimeHeaders,
        "sec-fetch-site": Schema.optionalKey(Schema.String)
      },
      success: RuntimeBytes,
      error: runtimeErrors
    }).annotateMerge(
      describe(
        runtimeAdmission +
          "GET additionally requires the exact browser header `Sec-Fetch-Site: same-origin`. " +
          "Principal and wire travel only in their required headers; GET has no request body. " +
          runtimeFileContract +
          "The byte response carries the stored `Content-Type` and `no-store`, never a redirect " +
          "to uploaded content. HTML and SVG remain bytes, never a navigable page."
      )
    )
  )
  .prefix("/api") {}

export class PatchyApi extends HttpApi.make("patchy")
  .add(AuthGroup, PatchesGroup, SdkGroup, RuntimeGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Patchy Cloud API",
      description:
        "Every route lives under `/api`. Most speak JSON; runtime file routes carry raw bytes. " +
        "`GET /api/release`, `POST /api/login/device` and `POST /api/login/device/token` are " +
        "unauthenticated. `/api/runtime/*` admits only the shell's browser requests with the " +
        "runtime headers and loaded-version admission described below; machine tokens are refused. " +
        "Other routes need `Authorization: Bearer <token>`; a missing or invalid token is a " +
        "401 with `{ ok: false, error }`. Refusals add `code` and operation-specific fields when " +
        "clients branch on them. A 429 carries `Retry-After` seconds; bearer API rate-limit " +
        "responses also carry `retryAfterSeconds`."
    })
  ) {}
