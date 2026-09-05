/**
 * The `/api/*` contract: two groups, `auth` and `patches`, every route with
 * its request, success and error shapes from `./schemas.ts`. The server
 * implements it and the CLI's client is derived from it; neither side
 * re-types a wire shape by hand. The route descriptions here are the text of
 * `docs/API.md`.
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
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
  UploadCreated,
  UploadRequest,
  UploadUpdated
} from "./schemas.js";

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
    HttpApiEndpoint.post("upload", "/uploads", {
      payload: UploadRequest,
      success: [UploadCreated, UploadUpdated],
      error: [PatchQuotaExceeded, ...protectedErrors, InvalidHtml, Conflict, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Publish a document for the bearer token's user. With no `patchId` it creates a patch " +
          "and answers 201; with one it adds a version to that user's patch and answers 200. " +
          "The HTML is checked against the safe-HTML policy first, and a 422 lists what failed. A create also debits " +
          "per-token create limit and counts against the user's live-patch quota; an update costs " +
          "nothing against either. Optional `scope` is `company` or `public`: omitted on a create " +
          "it defaults to `company`; omitted on an update it stays unchanged. An explicit scope sets it either way."
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
          "`company` requires a company member's browser session; `public` lets anyone with the link open it. " +
          "A patch the caller does not own answers 404. Both latest and version URLs follow the scope: " +
          "public responses may be cached for 60 seconds; company responses are private and never stored. " +
          "The JSON body is bounded by the upload body limit: 2 MiB by default, or three times " +
          "`PATCHY_MAX_HTML_BYTES` when that is larger. An oversized declared body answers 413; " +
          "streaming bodies are cut off at the cap. Rejected requests leave the scope unchanged."
      )
    ),
    HttpApiEndpoint.delete("delete", "/patches/:patchId", {
      params: patchParams,
      success: Ok,
      error: patchRouteErrors
    }).annotateMerge(
      describe(
        "Delete a patch owned by the bearer token's user. The patch stops serving at once " +
          "and its content goes with the next expiry sweep."
      )
    )
  )
  .middleware(Authorization)
  .prefix("/api") {}

export class PatchyApi extends HttpApi.make("patchy")
  .add(AuthGroup, PatchesGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Patchy Cloud API",
      description:
        "Every route lives under `/api` and speaks JSON. Only `POST /api/login/device` and " +
        "`POST /api/login/device/token` are unauthenticated. Every other route needs " +
        "`Authorization: Bearer <token>`; a missing or invalid token is a 401 with " +
        "`{ ok: false, error }`. A refusal is always `{ ok: false, error }`, plus a `code` and " +
        "the number a client needs on the ones it branches on. A 429 also carries a " +
        "`Retry-After` header with the same seconds as `retryAfterSeconds`."
    })
  ) {}
