/**
 * The `patches` group of the Patchy API, implemented over `Content`,
 * `Patches`, `Limits` and `Analytics`: publish, owner-only sharing and delete. The
 * identity comes from the bearer middleware the group declares; this
 * package never authenticates anyone.
 * The hosting server mounts the group with the rest of the API.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  Manifest,
  PublishRequest,
  PublishRefused,
  PublishKeyConflict,
  Release,
  MANIFEST_VERSION,
  WIRE_VERSION
} from "@patchy/api";
import { contentHash, validateHtml } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as PatchesConfig from "./PatchesConfig.js";

const notFound = () => refuse(NotFound, { ok: false, error: "Patch not found." });

const decodePublish = decodeBody(PublishRequest);
const decodeKey = decodeBody(
  Schema.Struct({
    publishKey: Schema.String.check(Schema.isMinLength(1)),
    patchId: Schema.optionalKey(Schema.Unknown),
    manifest: Schema.optionalKey(Schema.Unknown)
  })
);
const decodeRelease = decodeBody(
  Schema.Struct({ manifest: Schema.Struct({ release: Schema.String }) })
);
const decodeManifest = Schema.decodeUnknownEffect(Manifest, { onExcessProperty: "error" });
const decodeShare = decodeBody(ShareRequest);

/**
 * Which field failed decides the answer, as it always has: no usable document
 * is one refusal, an unusable target is another, anything else the generic one.
 */
const malformedPublish = (refusal: MalformedBody) =>
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

/** Object order is not payload identity; every field, including unknown fields, is hashed. */
const canonicalJson = (json: unknown) =>
  JSON.stringify(json, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value
  );

const rejected = (code: typeof PublishRefused.Type.code, error: string) =>
  refuse(PublishRefused, { ok: false, code, error });
const keyConflict = () =>
  refuse(PublishKeyConflict, {
    ok: false,
    code: "publish_key_conflict",
    error: "Publish key was already used with a different payload."
  });

/** Where the publication came from, as far as the request says. */
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
    const publishRateLimitPerMinute = yield* PatchesConfig.publishRateLimitPerMinute;
    const maxPublishBodyBytes = yield* PatchesConfig.maxPublishBodyBytes;
    const currentRelease = yield* PatchesConfig.release;
    const livePatchesPerUser = yield* PatchesConfig.livePatchesPerUser;

    const publicUrl = (patchId: string) => `${publicBaseUrl.replace(/\/+$/, "")}/d/${patchId}`;

    return handlers
      .handleRaw("publish", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const json = yield* readBody(maxPublishBodyBytes).pipe(
            Effect.catchTags({
              MalformedBody: (error) => Effect.succeed(malformedPublish(error)),
              BodyTooLarge: () =>
                Effect.succeed(
                  refuse(PayloadTooLarge, {
                    ok: false,
                    error: "Request body is too large."
                  })
                )
            })
          );
          if (HttpServerResponse.isHttpServerResponse(json)) return json;
          const key = yield* decodeKey(json).pipe(
            Effect.catchTags({
              MalformedBody: (error) => Effect.succeed(malformedPublish(error))
            })
          );
          if (HttpServerResponse.isHttpServerResponse(key)) return key;
          const digest = contentHash(canonicalJson(json));
          const replay = Effect.fn("PatchesApi.replay")(function* () {
            const stored = yield* patches
              .replay(identity.user.id, key.publishKey)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (Option.isNone(stored)) return undefined;
            return stored.value.payloadDigest === digest
              ? HttpServerResponse.text(stored.value.body, {
                  status: stored.value.status,
                  contentType: "application/json"
                })
              : keyConflict();
          });
          const previous = yield* replay();
          if (previous !== undefined) return previous;
          const replayOrRespond = (response: HttpServerResponse.HttpServerResponse) =>
            Effect.map(replay(), (stored) => stored ?? response);
          const attempt = yield* limits.consume({
            key: `authenticated-publish:${identity.machine.id}`,
            limit: publishRateLimitPerMinute,
            window: "1 minute"
          });
          if (!attempt.allowed) return yield* replayOrRespond(rateLimited(attempt));
          if (!("patchId" in key)) {
            const createAttempt = yield* limits.consume({
              key: `patch-create:${identity.machine.id}`,
              limit: createRateLimitPerMinute,
              window: "1 minute"
            });
            if (!createAttempt.allowed) return yield* replayOrRespond(rateLimited(createAttempt));
          }
          const release = yield* decodeRelease(json).pipe(
            Effect.catchTags({
              MalformedBody: () => Effect.succeed(rejected("invalid_manifest", "Invalid manifest."))
            })
          );
          if (HttpServerResponse.isHttpServerResponse(release)) return release;
          if (release.manifest.release !== currentRelease) {
            return yield* replayOrRespond(
              rejected(
                "release_mismatch",
                `Release ${release.manifest.release} does not match instance release ${currentRelease}; run patchy refresh.`
              )
            );
          }
          const manifest = yield* decodeManifest(key.manifest).pipe(
            Effect.catch(() => Effect.succeed(rejected("invalid_manifest", "Invalid manifest.")))
          );
          if (HttpServerResponse.isHttpServerResponse(manifest)) return manifest;
          if (manifest.manifestVersion !== MANIFEST_VERSION) {
            return rejected("invalid_manifest", `Manifest version must be ${MANIFEST_VERSION}.`);
          }
          const payload = yield* decodePublish(json).pipe(
            Effect.catchTags({
              MalformedBody: (error) => Effect.succeed(malformedPublish(error))
            })
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          if (manifest.tier > 0) return rejected("tier_mismatch", "Tier 1 is not served yet.");
          if (
            [manifest.tables, manifest.files, manifest.uses].some(
              (entries) => Object.keys(entries).length > 0
            )
          ) {
            return rejected("invalid_manifest", "Tables, files and uses are not provisioned yet.");
          }
          const validation = validateHtml(payload.html, { maxBytes: maxHtmlBytes });
          if (!validation.ok)
            return refuse(InvalidHtml, {
              ok: false,
              errors: validation.errors,
              warnings: validation.warnings
            });
          const patchId = payload.patchId ?? null;
          const quotaResponse = () =>
            refuse(PatchQuotaExceeded, {
              ok: false,
              error: `Patch quota reached: ${livePatchesPerUser} live patches per user. Delete or let a patch expire before creating another.`,
              code: "live_patch_quota_exceeded",
              quota: livePatchesPerUser
            });
          if (patchId === null) {
            const live = yield* patches
              .countLive(identity.user.id)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (live >= livePatchesPerUser) return yield* replayOrRespond(quotaResponse());
          }
          const origin = yield* requestOrigin;
          const metadata = payload.metadata;
          const recorded = yield* content
            .publish({
              patchId,
              companyId: identity.company.id,
              ownerUserId: identity.user.id,
              machineTokenId: identity.machine.id,
              scope: payload.scope,
              title: validation.title || manifest.name || "Untitled Patch",
              html: payload.html,
              filename: null,
              repoOrg: cleanText(metadata.repoOrg),
              repoName: cleanText(metadata.repoName),
              cliVersion: cleanText(metadata.cliVersion),
              gitBranch: cleanText(metadata.gitBranch),
              gitCommitSha: cleanText(metadata.gitCommitSha),
              manifest,
              publishKey: key.publishKey,
              payloadDigest: digest,
              wireVersion: WIRE_VERSION,
              publicBaseUrl,
              warnings: validation.warnings,
              livePatchQuota: livePatchesPerUser,
              ...origin
            })
            .pipe(
              Effect.catchTags({
                PatchUnavailable: () => replayOrRespond(notFound()),
                PatchConflict: () =>
                  replayOrRespond(refuse(Conflict, { ok: false, error: "Patch already exists." })),
                PublishKeyTaken: () => replayOrRespond(keyConflict()),
                PatchQuotaReached: () => replayOrRespond(quotaResponse()),
                SqlError: (error) =>
                  Effect.flatMap(replay(), (stored) =>
                    stored === undefined ? Effect.die(error) : Effect.succeed(stored)
                  ),
                InvalidObjectKey: Effect.die,
                PendingObjectExpired: Effect.die,
                StoreUnavailable: Effect.die
              })
            );
          if (HttpServerResponse.isHttpServerResponse(recorded)) return recorded;
          yield* analytics.track({
            name: patchId === null ? "patch.created" : "patch.updated",
            principalId: identity.user.id,
            properties: {
              patchId: recorded.patchId,
              machineTokenId: identity.machine.id,
              versionNumber: recorded.versionNumber,
              scope: recorded.scope,
              tier: recorded.tier,
              htmlBytes: new TextEncoder().encode(payload.html).length
            }
          });
          return HttpServerResponse.text(recorded.responseBody, {
            status: recorded.status,
            contentType: "application/json"
          });
        })
      )
      .handleRaw("share", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(maxPublishBodyBytes).pipe(
            Effect.flatMap(decodeShare),
            Effect.catchTags({
              MalformedBody: () =>
                Effect.succeed(refuse(BadRequest, { ok: false, error: "Malformed request body." })),
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
      );
  })
);

/** Public release discovery is separate from the bearer-protected patch group. */
export const releaseLayer = HttpApiBuilder.group(PatchyApi, "release", (handlers) =>
  Effect.gen(function* () {
    const release = yield* PatchesConfig.release;
    const base = yield* PatchesConfig.publicBaseUrl;
    return handlers.handle("release", () =>
      Effect.succeed(
        new Release({
          release,
          manifestVersion: MANIFEST_VERSION,
          wireVersion: WIRE_VERSION,
          package: {
            tarball: `${base.replace(/\/+$/, "")}/sdk/patchy-${release}.tgz`,
            integrity: null
          }
        })
      )
    );
  })
);
