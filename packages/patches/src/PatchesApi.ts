/**
 * The `patches` group of the Patchy API, implemented over `Content`,
 * `Patches`, `Limits` and `Analytics`: upload, owner-only sharing and delete. The
 * identity comes from the bearer middleware the group declares; this
 * package never authenticates anyone.
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
  InvalidHtml,
  type MalformedBody,
  NotFound,
  Ok,
  PatchQuotaExceeded,
  PatchyApi,
  PayloadTooLarge,
  rateLimited,
  readBody,
  refuse,
  Shared,
  ShareRequest,
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

const notFound = () => refuse(NotFound, { ok: false, error: "Patch not found." });

const decodeUpload = decodeBody(UploadRequest);
const decodeShare = decodeBody(ShareRequest);

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
    const livePatchesPerUser = yield* PatchesConfig.livePatchesPerUser;

    const publicUrl = (patchId: string) => `${publicBaseUrl.replace(/\/+$/, "")}/d/${patchId}`;

    return (
      handlers
        // Raw, so the per-token upload limit is checked before the body is
        // read, and the body's own refusals keep their wording.
        .handleRaw("upload", () =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;

            const attempt = yield* limits.consume({
              key: `authenticated-upload:${identity.machine.id}`,
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
            // user already holds, so it costs nothing against either ceiling.
            if (patchId === null) {
              // The per-minute bucket is spent before the quota is counted, so a
              // client parked at the quota is throttled instead of being free to
              // re-count the database at the higher upload-limit rate.
              const attempt = yield* limits.consume({
                key: `patch-create:${identity.machine.id}`,
                limit: createRateLimitPerMinute,
                window: "1 minute"
              });
              if (!attempt.allowed) return rateLimited(attempt);

              // Recounted from the database every time, so the ceiling outlives a
              // restart. Concurrent creates can overshoot it by at most the burst
              // the per-minute limiter above allows through.
              const live = yield* patches
                .countLive(identity.user.id)
                .pipe(Effect.catchTags({ SqlError: Effect.die }));
              if (live >= livePatchesPerUser) {
                // "Patch quota", not "patch limit": the glossary reserves
                // limit-shaped wording for the per-minute create limit.
                return refuse(PatchQuotaExceeded, {
                  ok: false,
                  error: `Patch quota reached: ${livePatchesPerUser} live patches per user. Delete or let a patch expire before creating another.`,
                  code: "live_patch_quota_exceeded",
                  quota: livePatchesPerUser
                });
              }
            }

            const filename = cleanText(payload.filename);
            const metadata: (typeof UploadMetadata)["Type"] | undefined = payload.metadata;
            const origin = yield* requestOrigin;
            const uploaded = yield* content
              .upload({
                patchId,
                companyId: identity.company.id,
                ownerUserId: identity.user.id,
                machineTokenId: identity.machine.id,
                scope: payload.scope,
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
              principalId: identity.user.id,
              properties: {
                patchId: recorded.patchId,
                machineTokenId: identity.machine.id,
                versionNumber: recorded.versionNumber,
                scope: recorded.scope,
                htmlBytes: new TextEncoder().encode(payload.html).length
              }
            });

            const body = {
              ok: true as const,
              patchId: recorded.patchId,
              versionId: recorded.versionId,
              versionNumber: recorded.versionNumber,
              title: recorded.title,
              scope: recorded.scope,
              publicUrl: publicUrl(recorded.patchId),
              warnings: validation.warnings
            };
            return patchId === null ? new UploadCreated(body) : new UploadUpdated(body);
          })
        )
        .handleRaw("share", ({ params }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            const payload = yield* readBody(maxUploadBodyBytes).pipe(
              Effect.flatMap(decodeShare),
              Effect.catchTags({
                MalformedBody: () =>
                  Effect.succeed(
                    refuse(BadRequest, { ok: false, error: "Malformed request body." })
                  ),
                BodyTooLarge: () =>
                  Effect.succeed(
                    refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." })
                  )
              })
            );
            if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
            const scope = yield* patches
              .setScope(params.patchId, identity.user.id, payload.scope)
              .pipe(
                Effect.catchTags({
                  PatchUnavailable: () => Effect.succeed(notFound()),
                  SqlError: Effect.die
                })
              );
            if (HttpServerResponse.isHttpServerResponse(scope)) return scope;
            return new Shared({
              ok: true,
              patchId: params.patchId,
              scope,
              publicUrl: publicUrl(params.patchId)
            });
          })
        )
        .handle("delete", ({ params }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            const deleted = yield* patches
              .delete(params.patchId, identity.user.id)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (!deleted) return notFound();
            yield* analytics.track({
              name: "patch.deleted",
              principalId: identity.user.id,
              properties: { patchId: params.patchId }
            });
            return new Ok({ ok: true });
          })
        )
    );
  })
);
