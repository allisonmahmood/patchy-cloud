/**
 * The `/api/*` contract: auth, patches, connections, browser runtime and public release discovery.
 * Request, success and error shapes come from the API's schema modules. The server
 * implements it and the CLI's client is derived from it; neither side
 * re-types a wire shape by hand. The route descriptions here are the text of
 * `docs/API.md`.
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as OpenApi from "effect/http-api/OpenApi";
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
  PatchSummary,
  PatchDetail,
  PatchStateFilter,
  PrimitiveDetail,
  PublishUnavailable,
  NotOwner,
  WrongState,
  PatchRetired,
  PatchDeleted,
  HasDependants,
  SourcesOff,
  ReservedName,
  InvalidDescription,
  VersionUnavailable,
  Tier2NotPublic,
  ForceRequest,
  Retired,
  Deleted,
  Restored,
  RollbackRequest,
  RolledBack,
  DescriptionRequest,
  Described,
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
  Connections,
  ConnectionDetail,
  ConnectionUnavailable,
  GenerateRequest,
  Generated
} from "./schemas.js";
import {
  RuntimeBytes,
  RuntimeCall,
  RuntimeFailure,
  RuntimeSuccess,
  RuntimeEventStream,
  ServerCallReply,
  RuntimeSubscriptionRequest,
  RuntimeSubscriptionAccepted
} from "./runtime.js";

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
 * The routes that take a patch id or name also answer 414 to an overlong
 * reference. Parameters are plain strings here on purpose: unknown or malformed
 * references are a 404 from the handler, not a 400 from the path.
 */
const patchRouteErrors = [...protectedErrors, RequestTargetTooLong] as const;
const patchParams = { patchId: Schema.String };
const ownerRouteErrors = [...patchRouteErrors, NotOwner, WrongState] as const;
const readParams = { patchRef: Schema.String };
const readQuery = { state: Schema.optionalKey(PatchStateFilter) };
/** A bare query flag is true; clients encode booleans as true/false. */
const queryFlag = Schema.Literals(["", "true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== "false"),
    encode: SchemaGetter.transform((value) => (value ? ("true" as const) : ("false" as const)))
  })
);

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
        NotOwner,
        PatchRetired,
        PatchDeleted,
        ReservedName,
        InvalidDescription,
        HasDependants,
        Tier2NotPublic,
        NotAdditive,
        PublishUnavailable,
        Conflict,
        PayloadTooLarge,
        PublishRefused
      ]
    }).annotateMerge(
      describe(
        "Publish an HTML artifact, a manifest, and a server artifact on tier 2. Without `patchId` creates a patch (201); " +
          "with an owned live `patchId` publishes a version (200). Authenticate, then replay by owner " +
          "and `publishKey` before limits or release validation: identical payloads return the " +
          "stored response and status, even after an upgrade; changed payloads answer 409 " +
          "`publish_key_conflict`. New attempts require the exact current release and manifest " +
          "version from `GET /api/release`. Tiers 0, 1 and 2 may define tables and file stores, provisioned additively; " +
          "tier 3 answers `tier_mismatch`. Tier 2 is admitted on dev and test instances; production requires the fleet executor. " +
          "Tier 2 requires `server`, a closed JavaScript module. Stored bytes are inspected in a throwaway process: " +
          "descriptor disagreement, load failure or timeout answers `invalid_manifest`. A server artifact below tier 2 is `tier_mismatch`. " +
          "Zero handlers warns. `artifacts.html` is always returned; tier 2 also returns `artifacts.server` and " +
          "`handlers: [{name, kind}]` sorted by name. Both artifact records carry `sha256` and UTF-8 `bytes`. " +
          "Publishing tier 2 to a public patch requires explicit company scope, otherwise `tier2_not_public`. " +
          "Stored versions retain their wire; tier 2 wire 1 fixes the guest protocol and workerd compatibility date. " +
          "Every table and file store requires a nonblank description; missing or blank descriptions " +
          "and table/store name collisions answer `invalid_manifest`. " +
          'The company directory is declared as `uses: { members: { kind: "members" } }`, ' +
          "without a resource id or schema stamp. Member columns require this declaration. " +
          'Postgres uses carry `{ kind: "postgres", handle, id, revision }`, keyed by alias. ' +
          "The handle and id must name the same connected company connection, otherwise " +
          "`connection_not_connected`; the revision must equal its current schema snapshot, " +
          "otherwise `stale_generated` (run `patchy refresh`). Credential rotation and retargeting " +
          "preserve the connection id. Postgres runtime calls retain the version's recorded snapshot. " +
          'Shared-table uses carry `{ kind: "sharedTable", patchId, table, id, revision }`, keyed by alias. ' +
          'Shared-store uses carry `{ kind: "sharedStore", patchId, store, id, revision }`. ' +
          "The resolved id is `<patchId>/<table>` or `<patchId>/<store>`, never a patch name; " +
          "revision stamps the source inventory. `files(description, { shared: true })` publishes " +
          "read access to every file in the store. Publish requires a live same-company source " +
          "the publisher can open and an inventory resource marked shared, otherwise " +
          "`patch_not_openable`. A stamp behind the source revision warns, not refuses. " +
          "Unsharing a defined table or store refuses with `has_dependants` and the distinct live declaring " +
          "patches, including declarations in retained versions, unless `force` is true. Ask the person you " +
          "are working for before forcing. Omission and rollback never change sharing. " +
          "Ownership and lifecycle are checked before validating HTML and again at commit: another company's " +
          "patch is 404; a same-company non-owner gets `not_owner` first, with the current owner. The owner " +
          "gets `patch_retired` or `patch_deleted` with `purgeAt`, and must restore before publishing. " +
          "Schema changes are checked before storage and rechecked under the patch lock. " +
          "Preflight conservatively refuses new indexes with existing uncompressed key tuples " +
          "over 2,000 bytes, and added columns that expand existing rows over the row limit. " +
          "`not_additive` names every refused object, change and fix. Omitted tables and stores remain in " +
          "the cumulative inventory with their data and appear as `unused`; a required column cannot be omitted. " +
          "A new table or store cannot take a name the other kind holds in the inventory, even omitted. " +
          "A publish replaces descriptions of the primitives it defines; omission and rollback preserve them. " +
          "Description-only changes do not advance the schema revision. The revision advances for schema or sharing changes, never for a new bundle alone. " +
          "File mode (empty definitions and no repo name, or file metadata) onto cumulative inventory " +
          "answers `has_primitives`; an empty named repo manifest may omit all tables. " +
          "Reports and schema revision are persisted for replay. " +
          "Tier 0 HTML passes the safe-HTML policy; executable or otherwise unsafe content answers " +
          "`tier_mismatch`. Empty or oversized tier 0 documents retain the HTML validation refusal. " +
          "Tier 1 and 2 HTML bundles are stored raw, without safe-HTML validation or transformation. " +
          "Tier 0 keeps `PATCHY_MAX_HTML_BYTES` (512 KiB); each scripted artifact uses `PATCHY_MAX_BUNDLE_BYTES` " +
          "(10 MiB), with oversized artifacts refused as 413. Creates spend the per-token create limit " +
          "and live-patch quota; updates do not. Omitted scope defaults to company on creates " +
          "and remains unchanged on updates. `manifest.name` is an exact company-scoped name " +
          "(3–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit); " +
          "another patch's current name, or any name of a retired or deleted patch, answers 409 `name_taken` on create or rename. " +
          "`patches` and `connections` are reserved names and answer 422 `reserved_name` on create. " +
          "Without a name, creates derive one from `metadata.filename` without its extension (title when absent), " +
          "normalize it, fall back to `patch` and add `-2`, `-3`, etc. on collision. Updates with " +
          "no name retain their existing name. Rename leaves a redirect until another patch " +
          "claims it; retire and delete reserve names until the deletion sweep reclaims the patch after 30 days. " +
          "`manifest.description` or file mode's `metadata.description` updates the description; omitted, the " +
          "cloud text remains. Descriptions collapse whitespace, permit at most 500 Unicode code points and " +
          "no control characters, and are returned with `descriptionUpdatedAt`. " +
          "`address` and `publicUrl` both name the absolute `/<company>/<name>` address. " +
          "The JSON body cap is three times the sum of the larger configured HTML or bundle cap and the server bundle cap."
      )
    ),
    HttpApiEndpoint.get("list", "/patches", {
      query: { ...readQuery, mine: Schema.optionalKey(queryFlag) },
      success: Schema.Struct({ patches: Schema.Array(PatchSummary) }),
      error: protectedErrors
    }).annotateMerge(
      describe(
        "List the bearer credential's openable company patches, including public patches but never another " +
          "company's. Machine tokens only; browser sessions do not grant API access. " +
          "`state` is live by default, retired for retired patches, or all for live, retired and deleted " +
          "patches not yet reclaimed. The recovery deadline limits restore; the deletion sweep makes a patch gone. " +
          "A bare `?mine` or `mine=true` restricts the list to the " +
          "token's owner; `mine=false` does not. Results are yours first, then the company's, sorted by " +
          "name within each group. Each row includes the canonical id, address, owner and deactivated " +
          "mark, description, lifecycle stamps, current version, tier and publish time. `purgeAt` is " +
          "30 days after deletion. Unopenable, disabled and gone patches are absent. " +
          "No connections, table names or business rows are returned. Responses are private, no-store."
      )
    ),
    HttpApiEndpoint.get("detail", "/patches/:patchRef", {
      params: readParams,
      query: readQuery,
      success: PatchDetail,
      error: [...patchRouteErrors, WrongState]
    }).annotateMerge(
      describe(
        "Read one openable company patch by canonical id or exact name, using the same state filter as " +
          "the list. Names resolve only non-deleted patches; ids resolve any retained state. " +
          "A resolved patch outside the requested state answers 409 `wrong_state` with its actual state. " +
          "Unknown, unopenable, disabled, foreign, gone and deleted-by-name references answer the same 404. " +
          "The summary gains `title`, a cumulative `inventory: { tables, stores } | null`, and `reads` " +
          "across every retained version, including declarations dropped by the current version. " +
          "Existing in-company sources retain their lifecycle state even when disabled or unopenable; " +
          "only openable sources expose a name. Source state does not imply permission to read it. " +
          "Sources absent from the company lookup are `gone` without a name; foreign metadata is never queried. " +
          "An unavailable company database means null inventory, never fabricated empty arrays. " +
          "Live shared tables and stores are declarable and carry " +
          "`patchy add shared-table <patchId>/<table>` or `patchy add shared-store <patchId>/<store>`. " +
          "Unshared resources carry `not_shared` and an owner-name hint; off sources carry `source_off`. " +
          "Reads identify stores with `store`, never a `table` field. " +
          "No versions, dependants or business rows are returned. Machine tokens only. " +
          "Overlong references answer 414. Responses are private, no-store."
      )
    ),
    HttpApiEndpoint.get("primitive", "/patches/:patchRef/primitives/:name", {
      params: { ...readParams, name: Schema.String },
      query: readQuery,
      success: PrimitiveDetail,
      error: [...patchRouteErrors, WrongState, PublishUnavailable]
    }).annotateMerge(
      describe(
        "Read one table or file store from a patch's cumulative inventory with the detail route's " +
          "id-or-name resolution, openability gate and state filter. Returns kind, name, description, " +
          "sharing, schema revision, columns and indexes, never rows or contents. Columns report " +
          "their name, kind, optional flag, an optional ref target and a default only when present; " +
          "an explicit null default stays present. Indexes report name, columns and uniqueness. " +
          "Stores have `kind: store`, live `shared` state and empty columns and indexes. " +
          "Both kinds include `declarable`, a refusal `reason` when applicable and an add `hint`. " +
          "A missing table or store answers 404; an unavailable inventory answers 503 " +
          "`source_unavailable`, not a missing primitive. Machine tokens only. " +
          "Overlong patch references answer 414. Responses are private, no-store."
      )
    ),
    HttpApiEndpoint.get("inventory", "/patches/:patchId/inventory", {
      params: patchParams,
      success: PatchInventory,
      error: [...patchRouteErrors, PublishUnavailable]
    }).annotateMerge(
      describe(
        "Read the cumulative table and file-store definitions and schema revision for an openable " +
          "same-company patch in any lifecycle state, including each primitive's stored description. " +
          "Omitted definitions and their descriptions remain here. Unknown, disabled, " +
          "gone and foreign patches answer 404. A primitive-free patch answers empty definitions and revision zero. " +
          "An existing ready company database is probed for inventory even when the current version " +
          "declares none: a failed platform commit may have left cumulative definitions. An unavailable " +
          "database answers `source_unavailable` (or `busy`), never a fabricated empty inventory."
      )
    ),
    HttpApiEndpoint.post("share", "/patches/:patchId/share", {
      params: patchParams,
      payload: ShareRequest,
      success: Shared,
      error: [...ownerRouteErrors, Tier2NotPublic, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Change the sharing scope of a patch owned by the bearer token's user, without publishing a version. " +
          "`company` requires a company member's browser session; `public` lets anyone with the link open the current version. " +
          "Only the current version of a public patch is public; older versions stay behind the company door. " +
          "Public sharing while the served version is tier 2 answers `tier2_not_public`. " +
          "A same-company non-owner answers 403 `not_owner`, including an admin's machine token; another company " +
          "answers 404. Only live patches permit scope changes, otherwise `wrong_state`. The current public version may be cached for 60 seconds " +
          "at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>`; older versions and company patches are " +
          "`private, no-store` and answer 401 without a session. " +
          "The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`; the larger scripted-bundle cap applies only to publishing. " +
          "An oversized declared body answers 413; " +
          "streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged."
      )
    ),
    HttpApiEndpoint.post("retire", "/patches/:patchId/retire", {
      params: patchParams,
      payload: ForceRequest,
      success: Retired,
      error: [...ownerRouteErrors, HasDependants, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Retire an owned live patch. It stops serving and its shared tables and stores stop answering readers. " +
          "Everything is retained indefinitely, including its names. Live dependants refuse with " +
          "`has_dependants` unless `force` is true. Ask the person you are working for before forcing. " +
          "The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. " +
          "An oversized declared body answers 413; streaming bodies are cut off at the cap. " +
          "Rejected requests leave the patch unchanged."
      )
    ),
    HttpApiEndpoint.delete("delete", "/patches/:patchId", {
      params: patchParams,
      query: { force: Schema.optionalKey(queryFlag) },
      success: Deleted,
      error: [...ownerRouteErrors, HasDependants]
    }).annotateMerge(
      describe(
        "Delete an owned live or retired patch. It stops serving but retains its names, versions, tables " +
          "and files through a fixed 30-day recovery window. `purgeAt` is the deadline; the deletion sweep " +
          "reclaims it at or after that time. From live, dependants refuse with `has_dependants` unless " +
          "`force` is true. Delete from retired has no dependant refusal. A bare `?force` means true."
      )
    ),
    HttpApiEndpoint.post("restore", "/patches/:patchId/restore", {
      params: patchParams,
      payload: ForceRequest,
      success: Restored,
      error: [...ownerRouteErrors, SourcesOff, PatchDeleted, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Restore an owned retired or deleted patch to live, preserving its address and description. " +
          "Deleted patches require the current time to be before `purgeAt`, otherwise `patch_deleted`. " +
          "The current version's off sources refuse with `sources_off`, listing each source's table and " +
          "state, including gone, unless `force` is true. Ask the person you are working for before forcing. " +
          "The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. " +
          "An oversized declared body answers 413; streaming bodies are cut off at the cap. " +
          "Rejected requests leave the patch unchanged."
      )
    ),
    HttpApiEndpoint.post("rollback", "/patches/:patchId/rollback", {
      params: patchParams,
      payload: RollbackRequest,
      success: RolledBack,
      error: [...ownerRouteErrors, VersionUnavailable, Tier2NotPublic, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Move an owned live patch's address to a retained `versionNumber`, creating no version. " +
          "Tables, files, sharing, name and description do not change. A missing version answers " +
          "422 `version_unavailable`; an off patch answers `wrong_state`. " +
          "A rollback to tier 2 while the patch is public answers `tier2_not_public`. " +
          "The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. " +
          "An oversized declared body answers 413; streaming bodies are cut off at the cap. " +
          "Rejected requests leave the patch unchanged."
      )
    ),
    HttpApiEndpoint.put("describe", "/patches/:patchId/description", {
      params: patchParams,
      payload: DescriptionRequest,
      success: Described,
      error: [...ownerRouteErrors, InvalidDescription, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Set an owned live or retired patch's description without publishing a version. Whitespace runs " +
          "collapse to spaces and surrounding whitespace is trimmed. The result is one paragraph of at " +
          "most 500 Unicode code points with no control characters; invalid text answers 422 " +
          "`invalid_description`. An empty string clears it. Markup is stored literally. A no-op save " +
          "does not change its timestamp. Deleted patches answer `wrong_state`. " +
          "The JSON body is bounded by three times `PATCHY_MAX_HTML_BYTES`, before decoding. " +
          "An oversized declared body answers 413; streaming bodies are cut off at the cap. " +
          "Rejected requests leave the patch unchanged."
      )
    )
  )
  .middleware(Authorization)
  .prefix("/api") {}

export class ConnectionsGroup extends HttpApiGroup.make("connections", { topLevel: true })
  .add(
    HttpApiEndpoint.get("listConnections", "/connections", {
      query: { all: Schema.optionalKey(queryFlag) },
      success: Connections,
      error: [ConnectionUnavailable, ...protectedErrors]
    }).annotateMerge(
      describe(
        "List the caller's company connections, including disconnected ones, for any active member. " +
          "Connected entries carry a copy-ready add hint; disconnected entries carry reason " +
          "`not_connected` and a /company/connections hint. A bare all or all=true also includes " +
          "every offered integration's connected state. No snapshots, credentials or business rows. " +
          "Responses are private, no-store."
      )
    ),
    HttpApiEndpoint.get("getConnection", "/connections/:handle", {
      params: { handle: Schema.String },
      success: ConnectionDetail,
      error: [ConnectionUnavailable, ...protectedErrors]
    }).annotateMerge(
      describe(
        "Read one company connection by its exact handle, for any active member. " +
          "The current immutable snapshot includes its revision and ISO takenAt timestamp, " +
          "including when the connection is disconnected. A missing snapshot is null, never an " +
          "empty database. Unknown handles and another company's connections answer the same 404. " +
          "Never returns credentials or business rows. Responses are private, no-store."
      )
    )
  )
  .middleware(Authorization)
  .prefix("/api") {}

export class SdkGroup extends HttpApiGroup.make("sdk", { topLevel: true })
  .add(
    HttpApiEndpoint.get("release", "/release", { success: Release }).annotateMerge(
      describe(
        "The current tooling release, manifest and wire versions, and the builder toolchain's tested " +
          "versions and accepted ranges. Unauthenticated. GET /sdk/patchy-<release>-<digest>.tgz " +
          "serves the exact tarball without authentication with Cache-Control: public, " +
          "max-age=31536000, immutable. The URL digest is lowercase SHA-256; integrity is the " +
          "SHA-512 Subresource Integrity digest of those bytes. Every advertised URL remains " +
          "retrievable after an upgrade or same-version rebuild. Discovery is no-store. Only " +
          "GET tarball-shaped paths are reserved; sdk remains a valid company handle. Unknown " +
          "or malformed archive names answer 404; storage failure or corrupt bytes answer 503, " +
          "both no-store. GET /llms.txt (text/plain) and GET /install.mjs (text/javascript) " +
          "answer without authentication, no-store, with the instance's public base URL in " +
          "their commands. /llms.txt tells an outside agent how to install the CLI and log in; " +
          "/install.mjs fetches this release, verifies the tarball's SHA-512 integrity before " +
          "installing it globally with npm, then runs patchy setup."
      )
    ),
    HttpApiEndpoint.post("generate", "/sdk/generate", {
      payload: GenerateRequest,
      success: Generated,
      error: [PublishRefused, PublishUnavailable, PayloadTooLarge, ...protectedErrors]
    })
      .middleware(Authorization)
      .annotateMerge(
        describe(
          "Resolve declarations against current company metadata and return finished managed files, uses stamps and typed declaration metadata. " +
            "Requires the exact current release. Refuses connection_not_connected, patch_not_openable and release_mismatch. " +
            "Present skills are sticky except patchy-server below tier 2 and patchy-members without uses.members; generation removes those skills. An unknown present skill refuses generation. Includes core and implied skills, " +
            "typed clients, contexts and fixture stubs. The metadata response field contains Postgres snapshots, shared-table definitions with recursive source ref targets and their shared declarations, and shared-store definitions. Store fixtures use `fixtures/shared-<alias>/README.md`; existing fixture directories are never overwritten. Metadata is never written to a generated file. Never returns manifest.json, credentials or business rows or bytes. " +
            "serverModules lists one-level server/*.ts filename stems discovered locally for tier 2, independent of manifest.handlers; tiers 0 and 1 send an empty list. Generation uses them only for type-only imports and never loads handler code. " +
            "Unknown fields anywhere in the body answer 400. The JSON body cap is 1 MiB: a declared larger length answers 413, and streaming bodies are cut off at the cap."
        )
      )
  )
  .prefix("/api") {}

/**
 * Raw handlers choose an explicit HTTP status when encoding RuntimeFailure:
 * the identical wire shape at each status cannot select its own status.
 */
const runtimeErrors = [400, 401, 403, 404, 409, 413, 429, 503, 504].map((status) =>
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
  "A public version answers `me` with null. Public tier 1 versions admit declared `members.*` reads " +
  "only for active signed-in members of the patch's company; all other data operations, including " +
  "unknown ones, return `not_available_on_public`. Public HTML contains no viewer identity. " +
  "Before directory work, the trusted shell uses the internal `principal` operation with a null " +
  "principal to bind `{ userId }`, then pins that principal for directory calls and streams. " +
  "Company versions require a browser session " +
  "(`session_expired`), a viewer who can open the patch (`access_denied`), and a principal " +
  "matching that session's user (`principal_changed`); company `me` may bootstrap with null. " +
  "Tier 2 documents admit handle redemption (`files.redeem`) but refuse direct name-based primitives " +
  "and integrations with `server_required`, even after rollback to a lower served tier. A loaded " +
  "lower-tier document cannot redeem handles and gets only `me` while tier 2 is served. " +
  "Wire compatibility is checked before dispatch (`shell_outdated`). Per-viewer per-patch calls " +
  "are limited to 300 per minute by the release contract; `rate_limited` is 429 with `Retry-After` seconds. " +
  "Company admission also uses a per-host-replica token bucket, 100 calls/second with burst 200 by default, " +
  "overridable per company. It counts company-scoped operations even without a database connection; " +
  "public `me` calls spend only their per-caller allowance. Company admission refuses with " +
  "`limit_exceeded` (429), `company.admission.rate`, scope `company`, the enforced rate and `retryAfter`. " +
  "Callbacks and subscription re-runs do not consume another company admission. Company connections " +
  "default to four slots with at most 32 waiters and a one-second wait inside the caller's deadline; " +
  "queue overflow or expiry is `busy` (503) with its limit metadata and `retryAfter`. " +
  "Registered limit refusals add `scope`, `limitId` and `value` (the enforced bound). " +
  "`retryAfter` is in seconds and is included only when retrying is safe, never for timeouts " +
  "or unknown outcomes. Runtime rate refusals identify the viewer's call rate, company admission rate, " +
  "or host tracked-key capacity. Registry-backed request, row, batch, result and file size refusals, " +
  "mutation and integration deadlines, and broker frame limits carry these fields. Wire request " +
  "size bounds include any envelope allowance. Other bounds, such as row counts and database " +
  "statement timeouts, may omit them. Contract bounds are fixed per release, as listed in `docs/limits.md`. " +
  "Responses, including failures, are `Cache-Control: no-store`. ";
const runtimeFileContract =
  "The trailing `*` is the file name, not an object URL. Encode the full name with " +
  "`encodeURIComponent(name)` so slashes travel as `%2F`; the router decodes exactly once. " +
  "The wildcard also accepts slash-separated segments and avoids the router's 100-character " +
  "named-parameter limit. Names are 1–512 UTF-8 bytes, with no empty, `.` or `..` segments; " +
  "`store` is a camelCase manifest-defined file store. Patch ids are twelve lowercase letters " +
  "or digits; version ids are `ver_` followed by 24 lowercase letters or digits. The loaded " +
  "manifest, never a client-supplied name, is the authority. Raw byte bodies are not JSON or " +
  "base64; the byte limit is 20 MiB (`runtime.file.bytes`), enforced against actual streamed " +
  "bytes. Invalid names, undeclared stores and missing files answer `invalid_request`. Each PUT " +
  "writes a fresh immutable object and changes the index only after the byte write succeeds. " +
  "Files belong to the patch and store, never a version; rollback and version cleanup preserve them. ";

export class RuntimeGroup extends HttpApiGroup.make("runtime", { topLevel: true })
  .add(
    HttpApiEndpoint.post("call", "/runtime/call", {
      headers: { ...runtimeHeaders, origin: Schema.optionalKey(Schema.String) },
      payload: RuntimeCall,
      success: ServerCallReply,
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
          "`members.list { cursor? }` and `members.search { text, cursor? }` return active " +
          "company candidates as `{ rows, cursor }`, in pages of 50. Search matches a literal, " +
          "case-insensitive prefix of the full name or email, not a surname or substring. " +
          "Order is lowercased name, lowercased email, then id; cursors bind to company and search. " +
          "`members.get { id }` resolves any company user, including deactivated users; " +
          "`members.getMany { ids }` preserves input order and duplicates with null for unknown " +
          "or other-company ids. More than 1,000 ids is `limit_exceeded` with `members.getMany`. " +
          "Each member is `{ id, name, email, admin, active }`. These reads require the fixed " +
          "`members` declaration and active same-company viewer authority, including on public tier 1 documents. All four operations subscribe " +
          "to the company directory revision. Tier 2 handlers may read the directory in all " +
          "three kinds; only queries track dependencies. Directory reads use the platform " +
          "database, outside the query's company-database snapshot. A `member` column stores " +
          "a user id and rejects a non-candidate with `invalid_row` on insertion or changed " +
          "assignment. Member columns may be optional but cannot have defaults. An unchanged inactive id passes. Eligibility is " +
          "checked when the write arrives, not when its transaction commits. " +
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
          "`server.call { handler, args, mutationKey? }` names a one-level `module.export`. " +
          'Its declared business refusal is HTTP 200 `{ ok: false, source: "handler", code, details? }`; ' +
          "successful handler data stays inside `{ ok: true, value }`, even when the value resembles a refusal. " +
          "Runtime validates the loaded version's handler descriptors and dispatches through its Executor. " +
          "Admission requires a live session, an eligible loaded version and company scope; public documents cannot call handlers. " +
          "Tier 2 documents cannot make name-based direct primitive or connection calls, even after rollback to tier 1 (`server_required`). " +
          "While tier 2 is served, an older tier 1 document may call only `me`. " +
          "Action concurrency defaults to eight per company and two per viewer per patch (`busy`). " +
          "The host owns deadlines independently of the HTTP caller: 3 s for queries, 5 s for mutations, 60 s for actions, plus at most 5 s for cleanup. " +
          "Unresolved effects remain `unknown_outcome`, never `handler_timeout`; a late guest reply cannot restore authority. " +
          "Mutations commit owned-table writes, their key and a validated result of at most 64 KiB in one SERIALIZABLE transaction. " +
          "A `40001` retries the whole handler up to three attempts in the original deadline; exhaustion is `write_conflict`, never `busy`. " +
          "Mutation calls require a fresh `<ms>-<128 random bits, base64url>` key using the stream's server clock. " +
          "A repeat returns the committed result; expired keys over 24 hours old, keys over five minutes ahead, and changed bindings or arguments are refused. " +
          "The client's mutation `unknown_outcome.retry()` re-sends that key and captured arguments; actions are never replayed. " +
          "Successful mutation replies include `revisions`, the resource revision vector committed with their writes. " +
          "`handler_failed` carries a host correlation id; exception messages and stacks remain in the invocation log. " +
          "The isolated local executor exercises this host path. " +
          "Request bodies allow 1 MiB plus envelope for " +
          "insert/update and 8 MiB plus envelope for insertMany; server.call handler arguments allow " +
          "1 MiB (`tier2.args.bytes`) with a 64 KiB allowance for the enclosing request. Postgres calls allow " +
          "256 KiB including parameters, and other calls 64 KiB. Overflow is `too_large` (413). Undeclared tables answer `table_not_declared`; " +
          "invalid fields/defaults answer `invalid_row`, uniqueness conflicts `unique_violation`, " +
          "and invalid pagination `invalid_cursor`. Unknown operations answer `invalid_request`. " +
          'Patchy refusals use a non-200 status and `{ ok: false, source: "patchy", error, code, details?, correlationId?, scope?, limitId?, value?, retryAfter? }`; every table mutation is ' +
          "logged before execution and logged failures carry their runtime-log correlation id. " +
          "Table and file mutations have a 30-second deadline (`runtime.mutation.deadline`), " +
          "the same one their log records; past it the call fails `timeout` (504). " +
          "Table and file reads are not logged. `files.list { store, prefix?, limit?, cursor? }` " +
          "returns `{ files: [{ name, size, contentType, updatedAt }], cursor }`, ordered by name " +
          "with a literal prefix and a keyset cursor bound to patch, store and prefix. Pages default " +
          "to 100, capped at 1,000 (`PATCHY_FILE_DEFAULT_PAGE`, `PATCHY_FILE_MAX_PAGE`), with an " +
          "8 MiB result cap (`runtime.result.bytes`), including the cursor. " +
          "Tier 2 callback list/stat metadata additionally includes a host-minted `handle`: 57 characters, " +
          "deterministic for viewer, company, consuming patch, loaded version, source store and exact " +
          "immutable object, with no filename or clock. Handles count against page and result bounds. " +
          "Nested `ctx.run` results retain the parent's binding. A handle preserves the handler's " +
          "selection until replacement or deletion; narrowing a row does not revoke an already returned handle. " +
          "`shared.files.list { alias, prefix?, limit?, cursor? }` uses the same page contract. " +
          "`shared.files.stat { alias, name }` returns metadata or null. Both recheck source access " +
          "and sharing live. Tier 2 queries and actions may list and stat; only actions may get bytes. " +
          "`files.delete { store, name }` removes only the index row and returns null idempotently. " +
          "File mutations log store/name as their resource. `files.put`, `files.get`, " +
          "`shared.files.get` and `files.redeem` require raw bytes routes; they are refused on this JSON route, " +
          "never serialized as JSON/base64. `files.discard { upload }` releases a staged upload and " +
          "returns null without an operation log. It requires a loaded tier 2 document, the exact " +
          "shell Origin, and the stage's company, viewer, patch and version binding. Missing, expired " +
          "or consumed stages return `not_found`. Public JSON files.put remains refused, including " +
          "the upload-adoption form reserved for private action callbacks."
      )
    ),
    HttpApiEndpoint.put("stageFile", "/runtime/staged-files/:patchId/:versionId", {
      params: { patchId: Schema.String, versionId: Schema.String },
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
          "Stages raw bytes for a tier 2 action. Requires the exact shell Origin and normal principal " +
          "and wire headers. Returns `{ ok: true, value: { token, size, contentType } }` with no-store. " +
          "The opaque token binds company, viewer, consuming patch and loaded version. Staging and " +
          "discard are unlogged transport; neither operation is available to handler callbacks. " +
          "An action adopts with `files.put { store, name, upload }` through its private callback; " +
          "that mutation is logged as files.put and keeps the staged content type. Before the action " +
          "handler runs, the host resolves all t.upload metadata from its stage records. Adoption " +
          "and a subsequent mutation are not atomic. An upload is single-use and expires after one " +
          "hour. Limits are 20 MiB per stage, 16 outstanding stages " +
          "and 100 MiB per viewer per patch, and 1 GiB outstanding per company."
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
          "with `no-store`. The 30-second mutation deadline includes reading the body; past it the " +
          "PUT fails `timeout` (504). A failed or oversized upload preserves the previous file."
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
    ),
    HttpApiEndpoint.get("getSharedFile", "/runtime/shared-files/:patchId/:versionId/:alias/*", {
      params: {
        patchId: Schema.String,
        versionId: Schema.String,
        alias: Schema.String,
        "*": Schema.String
      },
      headers: {
        ...runtimeHeaders,
        "sec-fetch-site": Schema.optionalKey(Schema.String)
      },
      success: RuntimeBytes,
      error: runtimeErrors
    }).annotateMerge(
      describe(
        runtimeAdmission +
          "Read-only shared-store bytes. The alias resolves through the loaded consumer manifest's " +
          "`sharedStore` declaration to a stable source patch id and store. The wildcard is the " +
          "file name, encoded once; slash-separated names are supported. Every read, URL creation " +
          "and download checks live source access and cumulative store sharing, otherwise " +
          "`access_denied`. A tier 1 consumer may read a tier 2 source. A document below its own " +
          "patch's served tier gets `server_required`. GET requires `Sec-Fetch-Site: same-origin`, " +
          "the principal and wire headers, and no body. Responses are raw bytes under the same " +
          "20 MiB limit as owned files, with the stored media type, `no-store`, attachment " +
          "disposition and a sandbox CSP. There are no shared writes."
      )
    ),
    HttpApiEndpoint.get("redeemFile", "/runtime/file-handles/:patchId/:versionId/:handle", {
      params: {
        patchId: Schema.String,
        versionId: Schema.String,
        handle: Schema.String
      },
      headers: {
        ...runtimeHeaders,
        "sec-fetch-site": Schema.optionalKey(Schema.String)
      },
      success: RuntimeBytes,
      error: runtimeErrors
    }).annotateMerge(
      describe(
        runtimeAdmission +
          "Redeems a file selected by a tier 2 handler, with the signed-in viewer's normal " +
          "principal and wire headers and `Sec-Fetch-Site: same-origin`. The 57-character handle " +
          "binds viewer, company, consuming patch, loaded version, source store and immutable object. " +
          "The MAC is checked first, then the current name pointer (`not_found`), then live source " +
          "access (`access_denied`). Every request rechecks authority, and reads are not logged. " +
          "The response is raw bytes with stored `Content-Type`, `no-store`, sandbox CSP, attachment " +
          "disposition and `X-Patchy-File-Name` containing the exact URI-encoded name. Lower-tier " +
          "documents cannot redeem handles, including when their patch serves tier 2."
      )
    )
  )
  .prefix("/api") {}

export class RuntimeStreamGroup extends HttpApiGroup.make("runtimeStream", { topLevel: true })
  .add(
    HttpApiEndpoint.get("stream", "/runtime/stream", {
      query: {
        patchId: Schema.optionalKey(Schema.String),
        versionId: Schema.optionalKey(Schema.String),
        documentId: Schema.optionalKey(Schema.String)
      },
      headers: {
        ...runtimeHeaders,
        "sec-fetch-site": Schema.optionalKey(Schema.String),
        "x-patchy-generation": Schema.optionalKey(Schema.String)
      },
      success: RuntimeEventStream,
      error: runtimeErrors
    }).annotateMerge(
      describe(
        "Browser-cookie authentication only; bearer tokens are refused. " +
          "`X-Patchy-Wire` is the decimal runtime wire; `X-Patchy-Principal` is JSON " +
          '`{"userId":"..."}` matching the current admitted viewer, never null. ' +
          "GET opens one fetch-streamed SSE connection per authenticated document on tiers 1 and 2. " +
          "`patchId` and `versionId` identify the retained loaded version; `documentId` is the " +
          "shell's 16–128 character base64url nonce. `Sec-Fetch-Site: same-origin` is required. " +
          "Every reconnect checks the session, company and loaded version again. Company " +
          "shells bootstrap this stream; public tier 1 shells open it lazily for declared " +
          "member-directory subscriptions after binding the authenticated principal. An authenticated " +
          "company document keeps its stream if the patch becomes public. Frames are `data: <JSON>\\n\\n`, without an event field. " +
          "The first frame is `{type:'hello',generation,serverTime}`, with an opaque generation " +
          "and Unix milliseconds; the current `{type:'served',versionId,tier}` follows. " +
          "Dev also sends `{type:'handlers',kinds}` with the complete host-inspected handler-kind map " +
          "on open/reconnect and before subscription wakes after each successful server rebind. " +
          "The trusted shell forwards this replacement to the existing document so newly added " +
          "mutations receive client-minted mutation keys without a page reload. " +
          "Replacing an open document requires its latest generation in " +
          "`X-Patchy-Generation`; a stale replacement is `invalid_request` (409). " +
          "A successful stream sets the opaque `patchy_stream_affinity` cookie, scoped to " +
          "`/api/runtime` with `HttpOnly` and `SameSite=Strict`; it is `Secure` when the trusted " +
          "public base URL uses HTTPS. Multi-replica ingress must enable application-cookie " +
          "stickiness with cookie name `patchy_stream_affinity`, routing the stream and its " +
          "subscription POSTs to the same replica. Round-robin routing without affinity is " +
          "unsupported. If failover loses the generation, a 409 triggers reconnect and fresh admission. " +
          "Publish and rollback send `served`; lost authority sends " +
          "`access_denied`, `principal_changed` or `session_expired`. `revoked` is reserved pending " +
          "the version-revocation decision in #425; no version-revocation state or action exists yet. " +
          "Tier 2 opens and resumes send `starting` while ensuring a company task binding, then `ready`. " +
          "The broker holds `server.call` requests within its frame bounds until ready; invocation deadlines begin only at admission. " +
          "A stream drop keeps held calls held. After 40 seconds without a binding, " +
          "`start_failed` (`code:'busy'`, `retryAfter` seconds, and the effective `scope`, `limitId`, `value`) refuses held calls once, without replay. " +
          "The shell covers the frame after two seconds, on first open and resume, with an accessible focus-held starting element. " +
          "Failure offers Retry and automatic backoff while the document stays open; later ready admits only new calls. " +
          "`closed` names `slow_consumer` or `replaced`. Network drops and host drain " +
          "reconnect with backoff; hidden documents suspend after 30 seconds, then re-admit on " +
          "return without changing loaded version. Expiry of the authenticated token ends the " +
          "stream normally. A refreshable stale token answers `session_refresh_required` (401), " +
          "so the browser refreshes its cookie without discarding the document. Only definitive " +
          "session loss is `session_expired`. Tier 1 table and member-directory subscriptions share this stream with tier 2 query subscriptions. " +
          "The registry bounds `stream.documents` at 8 per viewer per patch and " +
          "`stream.buffer.bytes` at 16 MiB; overflow closes with `slow_consumer`."
      )
    ),
    HttpApiEndpoint.post("subscriptions", "/runtime/subscriptions", {
      headers: {
        ...runtimeHeaders,
        "sec-fetch-site": Schema.optionalKey(Schema.String)
      },
      payload: RuntimeSubscriptionRequest,
      success: RuntimeSubscriptionAccepted,
      error: runtimeErrors
    }).annotateMerge(
      describe(
        "Browser-cookie authentication only; bearer tokens are refused. `X-Patchy-Wire` " +
          "must be the current decimal runtime wire, `X-Patchy-Principal` must be JSON " +
          '`{"userId":"..."}` matching the admitted viewer and never null, and ' +
          "`Sec-Fetch-Site: same-origin` is required. Reconcile a document's subscriptions " +
          "using its loaded version, document nonce and current stream generation. Control " +
          "requests share `runtime.calls.perMinute` with ordinary calls for the same viewer " +
          "and patch; exhaustion is `rate_limited` (429) with `Retry-After`. Public loaded " +
          "tier 1 versions admit only declared `members.*` subscriptions for same-company viewers; " +
          "other data subscriptions return `not_available_on_public` without closing " +
          "the lifecycle stream. Retained company versions remain eligible. Deltas " +
          "`{type:'subscribe',sequence,subscription}` and `{type:'unsubscribe',sequence,id}` " +
          "apply in order, starting at sequence 1. " +
          "A subscription is `{id,op,args,vector?,revision?}`; tier 1 supports `tables.list`, " +
          "`tables.get`, `shared.list`, `shared.get` and all four `members.*` reads. `get` watches the whole table. " +
          "Tier 2 supports `server.call` with `{handler,args}` and no mutation key; only queries " +
          "are admitted. Handlers belong to the document's retained loaded version, so publishing " +
          "a version without a handler does not remove it from an already loaded document. " +
          "Optional `vector` and `revision` describe the snapshot the client actually received, " +
          "not the last frame the server sent. Tier 2 resume revision checks ignore keys outside " +
          "the loaded version's owned tables/stores, declared shared resources and declared `members:<companyId>` directory. " +
          "`{type:'replace',sequence,subscriptions}` installs the full desired set and supersedes " +
          "buffered deltas through that sequence; older replacements are refused. All requests " +
          "also carry `patchId`, `versionId`, `documentId` and `generation`. A gap after 5 seconds " +
          "or more than 64 buffered deltas sends `resync_required`. `admitted` names the last " +
          "applied sequence. `snapshot` carries `id`, decimal query `revision`, `result` and " +
          "a revision `vector` with resource keys, directory `members:<companyId>` keys and source lifecycle `patch:<id>` keys; " +
          "`up-to-date` carries `id`, `revision` and `vector` when " +
          "the result is unchanged or resume reaches an equal vector without running the query. " +
          "Successful equal-vector checks emit no `re-run` event. " +
          "`error` carries `id`, `permanent` and the structured runtime or handler `error`. " +
          "A missing loaded handler, `handler_failed` or a result schema failure ends only that " +
          "subscription, preserving its last browser value. Declared business errors retain their " +
          "`source:'handler'`, `code` and `details`. Refusals inside handlers remain recoverable; " +
          "losing document authority sends a stopping lifecycle notice instead. The host traces " +
          "callback resources before access checks, canonicalising shared aliases to their owner. " +
          "Successful runs replace dependencies even for equal results; failed runs retain previous " +
          "and attempted resources so first-access refusals wake on reshare. Mid-run wakes are retained. " +
          "Only resources actually read are watched. Member reads, when declared, are outside the " +
          "company-database query snapshot. Mutations return committed resource revisions; render " +
          "from the subscription rather than replaying a mutation result into its data. " +
          "The newest subscription is refused at 64 per document, 256 per patch or 1024 per " +
          "company; snapshots are at most 8 MiB. Re-runs occupy at most two slots per company " +
          "and one per patch. Hosted query slots remain occupied until invocation resources settle, " +
          "including after a timeout or document disconnect; `unknown_outcome` is retryable. " +
          "Periodic durable reconciliation repairs missed wakes."
      )
    )
  )
  .prefix("/api") {}

export class PatchyApi extends HttpApi.make("patchy")
  .add(AuthGroup, PatchesGroup, ConnectionsGroup, SdkGroup, RuntimeGroup, RuntimeStreamGroup)
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
        "responses also carry `retryAfterSeconds`. The `patchy` CLI names itself on every " +
        "request with `Patchy-Cli: <release> <command> <agent>`, such as " +
        "`Patchy-Cli: 0.0.1 publish claude-code`. The server records the fields that parse in " +
        "usage records and nothing else; no route requires or answers the header."
    })
  ) {}
