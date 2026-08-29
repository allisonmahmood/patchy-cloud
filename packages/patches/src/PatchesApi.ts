/**
 * The `patches` group of the Patchy API, implemented over `Content`,
 * `Patches`, `Limits` and `Analytics`: the upload, the moderation reads,
 * disable, pin and unpin, delete. The principal comes from the bearer
 * middleware the group declares; this package never authenticates anyone.
 * The hosting server mounts the group with the rest of the API.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Analytics } from "@patchy/analytics";
import {
  BadRequest,
  Conflict,
  CurrentIdentity,
  decodeBody,
  DisableRequest,
  Forbidden,
  hasScope,
  InvalidHtml,
  type MalformedBody,
  malformedBody,
  ModeratedPatch as ModeratedPatchOnWire,
  NotFound,
  Ok,
  PatchQuotaExceeded,
  PatchView,
  PatchyApi,
  PayloadTooLarge,
  Pinned,
  PrincipalPatches,
  rateLimited,
  readBody,
  refuse,
  UploadCreated,
  UploadMetadata,
  UploadRequest,
  UploadUpdated
} from "@patchy/api";
import { validateHtml } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as PatchesConfig from "./PatchesConfig.js";

/**
 * How many of a principal's patches one moderation list read returns, newest
 * first. The list omits deleted patches and keeps disabled ones, so deleting
 * is the only act that drains a page of results: work the page, read again,
 * see the rest.
 */
const MODERATION_LIST_LIMIT = 200;

const forbidden = () =>
  refuse(Forbidden, { ok: false, error: "API token does not have the required scope." });

const notFound = () => refuse(NotFound, { ok: false, error: "Patch not found." });

const decodeUpload = decodeBody(UploadRequest);
const decodeDisable = decodeBody(DisableRequest);
/** A disable carries a reason and nothing else; this is room for one. */
const MAX_DISABLE_BODY_BYTES = 16 * 1024;

/**
 * Which field failed decides the answer, as it always has: no usable document
 * is one refusal, an unusable target is another, anything else the generic one.
 */
const malformedUpload = (refusal: MalformedBody) =>
  refuse(BadRequest, {
    ok: false,
    error:
      refusal.field === "patchId"
        ? "Invalid patch ID."
        : refusal.field === "html"
          ? "Missing HTML document."
          : "Malformed request body."
  });

const cleanText = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
};

/**
 * A patch as the moderation surface reports it. Spelled out field by field on
 * purpose: the record grows over time, and an operator response is not the
 * place for whatever a future column happens to hold. "Principal" rather than
 * "account" — the loop is operator-facing, and the glossary's word for the
 * ownership row is what it should hear.
 */
const moderationView = (
  patch: Patches.ModeratedPatch
): (typeof ModeratedPatchOnWire)["Encoded"] => ({
  id: patch.id,
  principalId: patch.accountId,
  createdByApiTokenId: patch.createdByApiTokenId,
  title: patch.title,
  createdAt: patch.createdAt,
  updatedAt: patch.updatedAt,
  expiresAt: patch.expiresAt,
  pinnedAt: patch.pinnedAt,
  deletedAt: patch.deletedAt,
  disabledAt: patch.disabledAt,
  disabledReason: patch.disabledReason
});

/** Where the upload came from, as far as the request says. */
const requestOrigin = Effect.map(HttpServerRequest.HttpServerRequest, (request) => ({
  sourceIp: Option.getOrNull(request.remoteAddress),
  userAgent: request.headers["user-agent"] ?? null
}));

export const layer = HttpApiBuilder.group(PatchyApi, "patches", (handlers) =>
  Effect.gen(function* () {
    const content = yield* Content.Content;
    const patches = yield* Patches.Patches;
    const limits = yield* Limits.Limits;
    const analytics = yield* Analytics.Analytics;
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    const maxHtmlBytes = yield* PatchesConfig.maxHtmlBytes;
    const createRateLimitPerMinute = yield* PatchesConfig.patchCreateRateLimitPerMinute;
    const uploadRateLimitPerMinute = yield* PatchesConfig.uploadRateLimitPerMinute;
    const maxUploadBodyBytes = yield* PatchesConfig.maxUploadBodyBytes;
    const livePatchesPerToken = yield* PatchesConfig.livePatchesPerToken;

    const publicUrl = (patchId: string) => `${publicBaseUrl.replace(/\/+$/, "")}/d/${patchId}`;

    return (
      handlers
        // Raw, because the order matters: the scope and the per-token upload
        // limit are checked before the body is read, so neither an
        // under-scoped token nor one past its limit can make the server read
        // a document, and the body's own refusals keep their wording.
        .handleRaw("upload", () =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (!hasScope(identity, "upload")) return forbidden();

            const attempt = yield* limits.consume({
              key: `authenticated-upload:${identity.apiTokenId}`,
              limit: uploadRateLimitPerMinute,
              window: "1 minute"
            });
            if (!attempt.allowed) return rateLimited(attempt);

            const json = yield* readBody(maxUploadBodyBytes).pipe(
              Effect.catchTags({
                MalformedBody: (refusal) => Effect.succeed(malformedUpload(refusal)),
                BodyTooLarge: () =>
                  Effect.succeed(
                    refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." })
                  )
              })
            );
            if (HttpServerResponse.isHttpServerResponse(json)) return json;
            // The wire renamed this field. A client still sending the old name
            // is told so, rather than answered with a fresh patch it did not ask for.
            if (typeof json === "object" && json !== null && "draftId" in json) {
              return refuse(BadRequest, {
                ok: false,
                error:
                  "Unknown field draftId: the wire renamed it to patchId. Send patchId to update that patch."
              });
            }
            const payload = yield* decodeUpload(json).pipe(
              Effect.catchTags({
                MalformedBody: (refusal) => Effect.succeed(malformedUpload(refusal))
              })
            );
            if (HttpServerResponse.isHttpServerResponse(payload)) return payload;

            const validation = validateHtml(payload.html, { maxBytes: maxHtmlBytes });
            if (!validation.ok) {
              return refuse(InvalidHtml, {
                ok: false,
                errors: validation.errors,
                warnings: validation.warnings
              });
            }

            const patchId = payload.patchId ?? null;
            // Only creates are quota-bearing. An update rewrites a patch the
            // token already holds, so it costs nothing against either ceiling.
            if (patchId === null) {
              // The per-minute bucket is spent before the quota is counted, so a
              // client parked at the quota is throttled instead of being free to
              // re-count the database at the higher upload-limit rate.
              const attempt = yield* limits.consume({
                key: `patch-create:${identity.apiTokenId}`,
                limit: createRateLimitPerMinute,
                window: "1 minute"
              });
              if (!attempt.allowed) return rateLimited(attempt);

              // Recounted from the database every time, so the ceiling outlives a
              // restart. Concurrent creates can overshoot it by at most the burst
              // the per-minute limiter above allows through.
              const live = yield* patches
                .countLive(identity.apiTokenId)
                .pipe(Effect.catchTags({ SqlError: Effect.die }));
              if (live >= livePatchesPerToken) {
                // "Patch quota", not "patch limit": the glossary reserves
                // limit-shaped wording for the per-minute create limit.
                return refuse(PatchQuotaExceeded, {
                  ok: false,
                  error: `Patch quota reached: ${livePatchesPerToken} live patches per token. Delete or let a patch expire before creating another.`,
                  code: "live_patch_quota_exceeded",
                  quota: livePatchesPerToken
                });
              }
            }

            const filename = cleanText(payload.filename);
            const metadata: (typeof UploadMetadata)["Type"] | undefined = payload.metadata;
            const origin = yield* requestOrigin;
            const uploaded = yield* content
              .upload({
                patchId,
                accountId: identity.accountId,
                apiTokenId: identity.apiTokenId,
                title: validation.title || filename || "Untitled Patch",
                html: payload.html,
                filename,
                repoOrg: cleanText(metadata?.repoOrg),
                repoName: cleanText(metadata?.repoName),
                cliVersion: cleanText(metadata?.cliVersion),
                gitBranch: cleanText(metadata?.gitBranch),
                gitCommitSha: cleanText(metadata?.gitCommitSha),
                ...origin
              })
              .pipe(
                Effect.catchTags({
                  // An unavailable target — unknown, unowned, disabled, deleted
                  // or expired — is one 404, so the answer never says which.
                  PatchUnavailable: () => Effect.succeed(notFound()),
                  PatchConflict: () =>
                    Effect.succeed(refuse(Conflict, { ok: false, error: "Patch already exists." })),
                  SqlError: Effect.die,
                  InvalidObjectKey: Effect.die,
                  StoreUnavailable: Effect.die
                })
              );
            if (HttpServerResponse.isHttpServerResponse(uploaded)) return uploaded;
            const recorded = uploaded;

            // Reported once the upload is committed, so the event describes a
            // patch that exists. The size is the stored bytes, not the content.
            yield* analytics.track({
              name: patchId === null ? "patch.created" : "patch.updated",
              principalId: identity.accountId,
              properties: {
                patchId: recorded.patchId,
                apiTokenId: identity.apiTokenId,
                versionNumber: recorded.versionNumber,
                htmlBytes: new TextEncoder().encode(payload.html).length
              }
            });

            const body = {
              ok: true as const,
              patchId: recorded.patchId,
              versionId: recorded.versionId,
              versionNumber: recorded.versionNumber,
              title: recorded.title,
              publicUrl: publicUrl(recorded.patchId),
              warnings: validation.warnings
            };
            return patchId === null ? new UploadCreated(body) : new UploadUpdated(body);
          })
        )
        // The moderation loop's first step: a flagged URL, answered with the
        // principal behind it and the token to revoke.
        .handle("read", ({ params }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (!hasScope(identity, "admin")) return forbidden();
            const patch = yield* patches
              .findForModeration(params.patchId)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (Option.isNone(patch)) return notFound();
            return new PatchView({ ok: true, patch: moderationView(patch.value) });
          })
        )
        // The second step: everything else that principal is holding, so one
        // takedown resolves the whole principal rather than the single page.
        .handle("listByPrincipal", ({ params }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (!hasScope(identity, "admin")) return forbidden();
            const listing = yield* patches
              .listByPrincipal(params.principalId, MODERATION_LIST_LIMIT)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            return new PrincipalPatches({
              ok: true,
              principalId: params.principalId,
              patches: listing.patches.map(moderationView),
              truncated: listing.truncated
            });
          })
        )
        // Raw, so a body the schema refuses — or none at all, which is `{}` —
        // answers in the wire's words rather than an empty 400.
        .handleRaw("disable", ({ params }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            const admin = hasScope(identity, "admin");
            const payload = yield* readBody(MAX_DISABLE_BODY_BYTES).pipe(
              Effect.flatMap(decodeDisable),
              Effect.catchTags({
                MalformedBody: () => Effect.succeed(malformedBody()),
                BodyTooLarge: () => Effect.succeed(malformedBody())
              })
            );
            if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
            const disabled = yield* patches
              .disable(
                params.patchId,
                identity.accountId,
                cleanText(payload.reason) ?? "Disabled.",
                {
                  canModerateAnyPrincipal: admin
                }
              )
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (!disabled) return notFound();
            yield* analytics.track({
              name: "patch.disabled",
              principalId: identity.accountId,
              properties: { patchId: params.patchId, admin }
            });
            return new Ok({ ok: true });
          })
        )
        // Pinning is an operator's act on the instance's own pages, so it is
        // admin-scoped and unowned: an admin pins any patch, whoever holds it.
        .handle("pin", ({ params }) => setPinned(params.patchId, true))
        .handle("unpin", ({ params }) => setPinned(params.patchId, false))
        .handle("delete", ({ params }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            const admin = hasScope(identity, "admin");
            const deleted = yield* patches
              .delete(params.patchId, identity.accountId, { canModerateAnyPrincipal: admin })
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (!deleted) return notFound();
            yield* analytics.track({
              name: "patch.deleted",
              principalId: identity.accountId,
              properties: { patchId: params.patchId, admin }
            });
            return new Ok({ ok: true });
          })
        )
    );

    function setPinned(patchId: string, pinned: boolean) {
      return Effect.gen(function* () {
        const identity = yield* CurrentIdentity;
        if (!hasScope(identity, "admin")) return forbidden();
        const applied = yield* patches
          .setPinned(patchId, pinned)
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
        if (!applied) return notFound();
        return new Pinned({ ok: true, pinned });
      });
    }
  })
);
