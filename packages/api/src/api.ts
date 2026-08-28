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
  CreatedToken,
  CreateTokenRequest,
  DisableRequest,
  Forbidden,
  Identity,
  InvalidHtml,
  MintedToken,
  MintQuotaExceeded,
  NotFound,
  Ok,
  PatchQuotaExceeded,
  PatchView,
  PayloadTooLarge,
  Pinned,
  PrincipalPatches,
  RateLimited,
  RequestTargetTooLong,
  RevokedToken,
  SelfServiceDisabled,
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
 * target was malformed, a per-minute bucket ran dry, the token lacks the
 * scope, or the route is not there.
 */
const protectedErrors = [BadRequest, Forbidden, NotFound, RateLimited] as const;

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
    HttpApiEndpoint.post("mint", "/tokens/self-service", {
      success: MintedToken,
      error: [BadRequest, SelfServiceDisabled, RateLimited, MintQuotaExceeded]
    }).annotateMerge(
      describe(
        "Mint a self-service token. Takes no input: an absent body and `{}` are both accepted. " +
          "The only route that admits a request with no credential — it is how a caller gets its " +
          "first token — so the instance's enabled flag, a per-address rate limit and a per-address " +
          "daily quota stand in for authentication. The plaintext token appears in this response " +
          "and nowhere else."
      )
    ),
    HttpApiEndpoint.get("me", "/me", {
      success: Identity,
      error: protectedErrors
    })
      .middleware(Authorization)
      .annotateMerge(
        describe("Who the bearer token is: its principal, its own id and name, and its scopes.")
      ),
    HttpApiEndpoint.post("createToken", "/tokens", {
      payload: CreateTokenRequest,
      success: CreatedToken,
      error: protectedErrors
    })
      .middleware(Authorization)
      .annotateMerge(
        describe(
          "Issue a token for the caller's own principal. Admin scope. `scopes` defaults to " +
            '`["upload"]` and `name` to `CLI API Token`. The plaintext token appears in this ' +
            "response and nowhere else."
        )
      ),
    HttpApiEndpoint.post("revokeToken", "/tokens/:apiTokenId/revoke", {
      params: { apiTokenId: Schema.String },
      success: RevokedToken,
      error: protectedErrors
    })
      .middleware(Authorization)
      .annotateMerge(
        describe(
          "Permanently revoke a token. Admin scope. Revoked is a state, never a deletion: the " +
            "token's patches stay up until they expire, with their retention top-ups frozen. " +
            "Idempotent — revoking twice answers the same, with the original `revokedAt` intact."
        )
      )
  )
  .prefix("/api") {}

export class PatchesGroup extends HttpApiGroup.make("patches", { topLevel: true })
  .add(
    HttpApiEndpoint.post("upload", "/uploads", {
      payload: UploadRequest,
      success: [UploadCreated, UploadUpdated],
      error: [...protectedErrors, InvalidHtml, PatchQuotaExceeded, Conflict, PayloadTooLarge]
    }).annotateMerge(
      describe(
        "Publish a document. Upload scope. With no `patchId` it creates a patch and answers " +
          "201; with one it adds a version to that patch and answers 200. The HTML is checked " +
          "against the safe-HTML policy first, and a 422 lists what failed. A create also debits " +
          "the per-token create limit and counts against the live-patch quota; an update costs " +
          "nothing against either."
      )
    ),
    HttpApiEndpoint.get("read", "/patches/:patchId", {
      params: patchParams,
      success: PatchView,
      error: patchRouteErrors
    }).annotateMerge(
      describe(
        "A patch as the moderation surface sees it: the principal behind it and the token that " +
          "created it. Admin scope. Answers for disabled, deleted and expired patches too."
      )
    ),
    HttpApiEndpoint.get("listByPrincipal", "/principals/:principalId/patches", {
      params: { principalId: Schema.String },
      success: PrincipalPatches,
      error: protectedErrors
    }).annotateMerge(
      describe(
        "Everything a principal holds, newest first, deleted patches omitted, at most 200 — " +
          "`truncated` says there is more. Admin scope."
      )
    ),
    HttpApiEndpoint.post("disable", "/patches/:patchId/disable", {
      params: patchParams,
      payload: DisableRequest,
      success: Ok,
      error: patchRouteErrors
    }).annotateMerge(
      describe(
        "Take a patch out of service. Its creator may disable it; admin scope reaches any " +
          "principal's. A disabled patch stops serving at once and keeps its row until the " +
          "expiry sweep takes it."
      )
    ),
    HttpApiEndpoint.post("pin", "/patches/:patchId/pin", {
      params: patchParams,
      success: Pinned,
      error: patchRouteErrors
    }).annotateMerge(
      describe(
        "Exempt a patch from expiry. Admin scope, any principal's patch. Only a patch in " +
          "service can be pinned: a deleted or disabled one is a 404."
      )
    ),
    HttpApiEndpoint.post("unpin", "/patches/:patchId/unpin", {
      params: patchParams,
      success: Pinned,
      error: patchRouteErrors
    }).annotateMerge(
      describe(
        "Hand a pinned patch back to its retention clock, at whatever time it has left. Admin " +
          "scope. Works on anything still there."
      )
    ),
    HttpApiEndpoint.delete("delete", "/patches/:patchId", {
      params: patchParams,
      success: Ok,
      error: patchRouteErrors
    }).annotateMerge(
      describe(
        "Delete a patch. Its creator may delete it; admin scope reaches any principal's. The " +
          "patch stops serving at once and its content goes with the next expiry sweep."
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
        "Every route lives under `/api` and speaks JSON. Every route but the self-service mint " +
        "needs `Authorization: Bearer <token>`; a missing or invalid token is a 401 with " +
        "`{ ok: false, error }`. A refusal is always `{ ok: false, error }`, plus a `code` and " +
        "the number a client needs on the ones it branches on. A 429 also carries a " +
        "`Retry-After` header with the same seconds as `retryAfterSeconds`."
    })
  ) {}
