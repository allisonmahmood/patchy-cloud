/**
 * The `patches` group of the Patchy API, implemented over `Content`,
 * `Patches`, `Limits` and `Analytics`: discovery, publish and owner lifecycle actions. The
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
  DescriptionRequest,
  ForceRequest,
  InvalidHtml,
  type MalformedBody,
  NotFound,
  NameTaken,
  PatchId,
  NotOwner,
  WrongState,
  PatchRetired,
  PatchDeleted,
  HasDependants,
  SourcesOff,
  ReservedName,
  InvalidDescription,
  VersionUnavailable,
  Retired,
  Deleted,
  Restored,
  RolledBack,
  RollbackRequest,
  Described,
  NotAdditive,
  PublishUnavailable,
  PatchQuotaExceeded,
  PatchyApi,
  PatchInventory,
  PatchSummary,
  PatchDetail,
  PrimitiveDetail,
  type PatchTableSummary,
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
  MANIFEST_VERSION,
  WIRE_VERSION
} from "@patchy/api";
import { contentHash, validateHtml } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as PatchesConfig from "./PatchesConfig.js";

const notFound = () => refuse(NotFound, { ok: false, error: "Patch not found." });
const databaseUnavailable = () =>
  refuse(PublishUnavailable, {
    ok: false,
    code: "source_unavailable",
    error: "Company database is unavailable."
  });
const encodeInventory = Schema.encodeSync(PatchInventory);
const encodeSummaries = Schema.encodeSync(Schema.Array(PatchSummary));
const encodeDetail = Schema.encodeSync(PatchDetail);
const encodePrimitive = Schema.encodeSync(PrimitiveDetail);
const readHeaders = { "cache-control": "private, no-store" };
const summary = (row: Patches.ReadPatch, userId: string, publicBaseUrl: string) =>
  new PatchSummary({
    id: row.patch.id,
    name: row.patch.name,
    address: Patches.address(publicBaseUrl, row.patch.companyHandle, row.patch.name),
    owner: row.owner,
    mine: row.owner.id === userId,
    tier: row.tier,
    scope: row.patch.scope,
    description: row.patch.description,
    state: row.patch.state,
    retiredAt: row.patch.retiredAt,
    deletedAt: row.patch.deletedAt,
    purgeAt: row.patch.purgeAt,
    currentVersion: row.currentVersion,
    publishedAt: row.publishedAt
  });
const tableSummary = (
  row: Patches.ReadPatch,
  name: string,
  table: (typeof PatchInventory.Type.tables)[string]
): typeof PatchTableSummary.Type => {
  const common = { name, description: table.description, shared: table.shared === true };
  if (row.patch.state !== "live") {
    return {
      ...common,
      declarable: false,
      reason: "source_off",
      hint: `This source is ${row.patch.state}. Ask ${row.owner.name} or an admin to restore it.`
    };
  }
  return table.shared
    ? {
        ...common,
        declarable: true,
        hint: `patchy add shared-table ${row.patch.id}/${name}`
      }
    : {
        ...common,
        declarable: false,
        reason: "not_shared",
        hint: `Not shared. Ask ${row.owner.name} to share this table.`
      };
};
const lifecycleFailures = {
  NotOwner: (error: Patches.NotOwner) =>
    Effect.succeed(
      refuse(NotOwner, {
        ok: false,
        code: "not_owner",
        error: error.message,
        owner: error.owner
      })
    ),
  WrongState: (error: Patches.WrongState) =>
    Effect.succeed(
      refuse(WrongState, {
        ok: false,
        code: "wrong_state",
        error: error.message,
        state: error.state
      })
    ),
  PatchRetired: (error: Patches.PatchRetired) =>
    Effect.succeed(
      refuse(PatchRetired, {
        ok: false,
        code: "patch_retired",
        error: error.message
      })
    ),
  PatchDeleted: (error: Patches.PatchDeleted) =>
    Effect.succeed(
      refuse(PatchDeleted, {
        ok: false,
        code: "patch_deleted",
        error: error.message,
        purgeAt: error.purgeAt
      })
    ),
  HasDependants: (error: Patches.HasDependants) =>
    Effect.succeed(
      refuse(HasDependants, {
        ok: false,
        code: "has_dependants",
        error: error.message,
        dependants: error.dependants
      })
    ),
  SourcesOff: (error: Patches.SourcesOff) =>
    Effect.succeed(
      refuse(SourcesOff, {
        ok: false,
        code: "sources_off",
        error: error.message,
        sources: error.sources
      })
    ),
  ReservedName: (error: Patches.ReservedName) =>
    Effect.succeed(
      refuse(ReservedName, {
        ok: false,
        code: "reserved_name",
        error: error.message
      })
    ),
  InvalidDescription: (error: Patches.InvalidDescription) =>
    Effect.succeed(
      refuse(InvalidDescription, {
        ok: false,
        code: "invalid_description",
        error: error.message
      })
    ),
  VersionUnavailable: (error: Patches.VersionUnavailable) =>
    Effect.succeed(
      refuse(VersionUnavailable, {
        ok: false,
        code: "version_unavailable",
        error: error.message
      })
    ),
  InvalidOwner: Effect.die
};
const ownerFailures = {
  ...lifecycleFailures,
  PatchUnavailable: () => Effect.succeed(notFound()),
  SqlError: Effect.die
};
const readFailures = {
  PatchUnavailable: ownerFailures.PatchUnavailable,
  WrongState: (error: Patches.WrongState) =>
    Effect.succeed(
      refuse(WrongState, {
        ok: false,
        code: "wrong_state",
        state: error.state,
        error: `This patch is ${error.state}; request ?state=${error.state === "deleted" ? "all" : error.state}.`
      })
    ),
  SqlError: Effect.die
};
const isPatchId = Schema.is(PatchId);

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
const decodeForce = decodeBody(ForceRequest);
const decodeRollback = decodeBody(RollbackRequest);
const decodeDescription = decodeBody(DescriptionRequest);
const bodyFailures = {
  MalformedBody: () =>
    Effect.succeed(refuse(BadRequest, { ok: false, error: "Malformed request body." })),
  BodyTooLarge: () =>
    Effect.succeed(refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." }))
};

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
    const openability = yield* Patches.Openability;
    const limits = yield* Limits.Limits;
    const analytics = yield* Analytics.Analytics;
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    const maxHtmlBytes = yield* PatchesConfig.maxHtmlBytes;
    const maxBundleBytes = yield* PatchesConfig.maxBundleBytes;
    const createRateLimitPerMinute = yield* PatchesConfig.patchCreateRateLimitPerMinute;
    const publishRateLimitPerMinute = yield* PatchesConfig.publishRateLimitPerMinute;
    const maxPublishBodyBytes = yield* PatchesConfig.maxPublishBodyBytes;
    // Larger scripted bundles widen only publish; owner actions keep the sharing request cap.
    const maxShareBodyBytes = maxHtmlBytes * 3;
    const currentRelease = yield* PatchesConfig.release;
    const livePatchesPerUser = yield* PatchesConfig.livePatchesPerUser;

    const readOne = Effect.fn("PatchesApi.readOne")(function* (
      patchRef: string,
      state: Patches.ReadOptions["state"],
      identity: CurrentIdentity["Service"]
    ) {
      const rows = yield* patches
        .read({
          companyId: identity.company.id,
          userId: identity.user.id,
          canOpen: (patch) => openability(patch, identity.user.id),
          state,
          patchRef
        })
        .pipe(Effect.catchTags(readFailures));
      return HttpServerResponse.isHttpServerResponse(rows) ? rows : (rows[0] ?? notFound());
    });

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
          if (isPatchId(key.patchId)) {
            const admission = yield* patches
              .authorizePublish({
                intent: "update",
                patchId: key.patchId,
                ownerUserId: identity.user.id
              })
              .pipe(
                Effect.catchTags({
                  NotOwner: lifecycleFailures.NotOwner,
                  PatchRetired: lifecycleFailures.PatchRetired,
                  PatchDeleted: lifecycleFailures.PatchDeleted,
                  PatchUnavailable: ownerFailures.PatchUnavailable,
                  SqlError: Effect.die,
                  PatchConflict: () =>
                    Effect.succeed(refuse(Conflict, { ok: false, error: "Patch already exists." }))
                })
              );
            if (HttpServerResponse.isHttpServerResponse(admission)) return admission;
          }
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
          if (manifest.tier >= 2)
            return rejected("tier_mismatch", "Tier 2 and above are not served yet.");
          const bytes = Buffer.byteLength(payload.html, "utf8");
          let title = manifest.name || "Untitled Patch";
          let warnings: string[] = [];
          if (manifest.tier === 0) {
            if (payload.html.trim() === "" || bytes > maxHtmlBytes)
              return refuse(InvalidHtml, {
                ok: false,
                errors: [
                  payload.html.trim() === ""
                    ? "HTML document is empty."
                    : `HTML document is ${bytes} bytes; maximum is ${maxHtmlBytes} bytes.`
                ],
                warnings: []
              });
            const validation = validateHtml(payload.html, { maxBytes: maxHtmlBytes });
            if (!validation.ok) return rejected("tier_mismatch", validation.errors.join(" "));
            title = validation.title || title;
            warnings = validation.warnings;
          } else {
            if (bytes > maxBundleBytes)
              return refuse(PayloadTooLarge, {
                ok: false,
                error: `HTML bundle is ${bytes} bytes; maximum is ${maxBundleBytes} bytes.`
              });
          }
          const patchId = payload.patchId ?? null;
          const quotaResponse = () =>
            refuse(PatchQuotaExceeded, {
              ok: false,
              error: `Patch quota reached: ${livePatchesPerUser} patches per user. Delete a patch before creating another; retired patches still count.`,
              code: "live_patch_quota_exceeded",
              quota: livePatchesPerUser
            });
          if (patchId === null) {
            const counted = yield* patches
              .countQuotaPatches(identity.user.id)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (counted >= livePatchesPerUser) return yield* replayOrRespond(quotaResponse());
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
              force: payload.force,
              description: metadata.description ?? manifest.description,
              title,
              html: payload.html,
              filename: cleanText(metadata.filename),
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
              warnings,
              livePatchQuota: livePatchesPerUser,
              ...origin
            })
            .pipe(
              Effect.catchTags({
                ...lifecycleFailures,
                PatchUnavailable: () => replayOrRespond(notFound()),
                PatchConflict: () =>
                  replayOrRespond(refuse(Conflict, { ok: false, error: "Patch already exists." })),
                NameTaken: (error) =>
                  replayOrRespond(
                    refuse(NameTaken, { ok: false, code: "name_taken", error: error.message })
                  ),
                PublishKeyTaken: () => replayOrRespond(keyConflict()),
                PatchQuotaReached: () => replayOrRespond(quotaResponse()),
                HasPrimitives: (error) =>
                  replayOrRespond(rejected("has_primitives", error.message)),
                PatchNotOpenable: (error) =>
                  replayOrRespond(rejected("patch_not_openable", error.message)),
                ConnectionNotConnected: (error) =>
                  replayOrRespond(rejected("connection_not_connected", error.message)),
                StaleGenerated: (error) =>
                  replayOrRespond(rejected("stale_generated", error.message)),
                NotAdditive: (error) =>
                  replayOrRespond(
                    refuse(NotAdditive, {
                      ok: false,
                      code: "not_additive",
                      error: error.message,
                      changes: error.changes
                    })
                  ),
                Busy: (error) =>
                  replayOrRespond(
                    refuse(PublishUnavailable, {
                      ok: false,
                      code: "busy",
                      error: error.message
                    })
                  ),
                CompanyDatabaseError: () => replayOrRespond(databaseUnavailable()),
                CompanyDatabaseNotReady: () => replayOrRespond(databaseUnavailable()),
                ConnectionStorageFailed: () => replayOrRespond(databaseUnavailable()),
                CompanyIdentityMismatch: Effect.die,
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
              htmlBytes: bytes
            }
          });
          return HttpServerResponse.text(recorded.responseBody, {
            status: recorded.status,
            contentType: "application/json"
          });
        })
      )
      .handleRaw(
        "list",
        Effect.fn("PatchesApi.list")(function* ({ query }) {
          const identity = yield* CurrentIdentity;
          const rows = yield* patches
            .read({
              companyId: identity.company.id,
              userId: identity.user.id,
              canOpen: (patch) => openability(patch, identity.user.id),
              state: query.state ?? "live",
              mine: query.mine
            })
            .pipe(Effect.catchTags(readFailures));
          if (HttpServerResponse.isHttpServerResponse(rows)) return rows;
          return HttpServerResponse.jsonUnsafe(
            {
              patches: encodeSummaries(
                rows.map((row) => summary(row, identity.user.id, publicBaseUrl))
              )
            },
            { headers: readHeaders }
          );
        })
      )
      .handleRaw(
        "detail",
        Effect.fn("PatchesApi.detail")(function* ({ params, query }) {
          const identity = yield* CurrentIdentity;
          const row = yield* readOne(params.patchRef, query.state ?? "live", identity);
          if (HttpServerResponse.isHttpServerResponse(row)) return row;
          return HttpServerResponse.jsonUnsafe(
            encodeDetail(
              new PatchDetail({
                ...summary(row, identity.user.id, publicBaseUrl),
                title: row.patch.title,
                descriptionUpdatedAt: row.patch.descriptionUpdatedAt,
                inventory:
                  row.inventory === null
                    ? null
                    : {
                        tables: Object.entries(row.inventory.tables).map(([name, table]) =>
                          tableSummary(row, name, table)
                        ),
                        stores: Object.entries(row.inventory.files).map(([name, store]) => ({
                          name,
                          description: store.description,
                          declarable: false as const,
                          reason: "not_shareable" as const,
                          hint: "File stores are not shareable yet."
                        }))
                      },
                reads: row.reads
              })
            ),
            { headers: readHeaders }
          );
        })
      )
      .handleRaw(
        "primitive",
        Effect.fn("PatchesApi.primitive")(function* ({ params, query }) {
          const identity = yield* CurrentIdentity;
          const row = yield* readOne(params.patchRef, query.state ?? "live", identity);
          if (HttpServerResponse.isHttpServerResponse(row)) return row;
          if (row.inventory === null) return databaseUnavailable();
          const table = Object.hasOwn(row.inventory.tables, params.name)
            ? row.inventory.tables[params.name]
            : undefined;
          const store = Object.hasOwn(row.inventory.files, params.name)
            ? row.inventory.files[params.name]
            : undefined;
          if (table === undefined && store === undefined)
            return refuse(NotFound, { ok: false, error: "Primitive not found." });
          return HttpServerResponse.jsonUnsafe(
            encodePrimitive(
              new PrimitiveDetail({
                kind: table === undefined ? "store" : "table",
                name: params.name,
                description: (table ?? store)!.description,
                shared: table?.shared === true,
                schemaRevision: row.inventory.schemaRevision,
                columns:
                  table === undefined
                    ? []
                    : Object.entries(table.columns).map(([name, column]) => ({
                        name,
                        kind: column.kind,
                        optional: column.optional === true,
                        ...(Object.hasOwn(column, "default") ? { default: column.default! } : {}),
                        ...(column.kind === "ref" ? { ref: column.table } : {})
                      })),
                indexes:
                  table === undefined
                    ? []
                    : Object.entries(table.indexes).map(([name, index]) => ({
                        name,
                        columns: index.columns,
                        unique: index.unique === true
                      }))
              })
            ),
            { headers: readHeaders }
          );
        })
      )
      .handleRaw("inventory", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const result = yield* patches.inventory(params.patchId, identity.user.id).pipe(
            Effect.catchTags({
              PatchUnavailable: () => Effect.succeed(notFound()),
              Busy: (error) =>
                Effect.succeed(
                  refuse(PublishUnavailable, {
                    ok: false,
                    code: "busy",
                    error: error.message
                  })
                ),
              CompanyDatabaseError: () => Effect.succeed(databaseUnavailable()),
              CompanyDatabaseNotReady: () => Effect.succeed(databaseUnavailable()),
              CompanyIdentityMismatch: Effect.die,
              SqlError: Effect.die
            })
          );
          if (HttpServerResponse.isHttpServerResponse(result)) return result;
          return HttpServerResponse.jsonUnsafe(encodeInventory(result), {
            headers: { "cache-control": "private, no-store" }
          });
        })
      )
      .handleRaw("share", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(maxShareBodyBytes).pipe(
            Effect.flatMap(decodeShare),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const shared = yield* patches
            .setScope(params.patchId, { userId: identity.user.id, admin: false }, payload.scope)
            .pipe(Effect.catchTags(ownerFailures));
          if (HttpServerResponse.isHttpServerResponse(shared)) return shared;
          return new Shared({
            ok: true,
            patchId: params.patchId,
            scope: shared.scope,
            publicUrl: Patches.address(publicBaseUrl, shared.companyHandle, shared.name)
          });
        })
      )
      .handleRaw("retire", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(maxShareBodyBytes).pipe(
            Effect.flatMap(decodeForce),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const patch = yield* patches
            .retire(params.patchId, { userId: identity.user.id, admin: false }, payload.force)
            .pipe(Effect.catchTags(ownerFailures));
          if (HttpServerResponse.isHttpServerResponse(patch)) return patch;
          return new Retired({
            ok: true,
            patchId: patch.id,
            state: "retired",
            retiredAt: patch.retiredAt!
          });
        })
      )
      .handleRaw("restore", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(maxShareBodyBytes).pipe(
            Effect.flatMap(decodeForce),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const patch = yield* patches
            .restore(params.patchId, { userId: identity.user.id, admin: false }, payload.force)
            .pipe(Effect.catchTags(ownerFailures));
          if (HttpServerResponse.isHttpServerResponse(patch)) return patch;
          return new Restored({ ok: true, patchId: patch.id, state: "live" });
        })
      )
      .handleRaw("rollback", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(maxShareBodyBytes).pipe(
            Effect.flatMap(decodeRollback),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const result = yield* patches
            .rollback(
              params.patchId,
              { userId: identity.user.id, admin: false },
              payload.versionNumber
            )
            .pipe(Effect.catchTags(ownerFailures));
          if (HttpServerResponse.isHttpServerResponse(result)) return result;
          return new RolledBack({
            ok: true,
            patchId: result.patch.id,
            currentVersion: result.currentVersion,
            address: Patches.address(publicBaseUrl, result.patch.companyHandle, result.patch.name)
          });
        })
      )
      .handleRaw("describe", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(maxShareBodyBytes).pipe(
            Effect.flatMap(decodeDescription),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const patch = yield* patches
            .setDescription(
              params.patchId,
              { userId: identity.user.id, admin: false },
              payload.description
            )
            .pipe(Effect.catchTags(ownerFailures));
          if (HttpServerResponse.isHttpServerResponse(patch)) return patch;
          return new Described({
            ok: true,
            patchId: patch.id,
            description: patch.description,
            descriptionUpdatedAt: patch.descriptionUpdatedAt
          });
        })
      )
      .handle("delete", ({ params, query }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const patch = yield* patches
            .delete(params.patchId, { userId: identity.user.id, admin: false }, query.force)
            .pipe(Effect.catchTags(ownerFailures));
          if (HttpServerResponse.isHttpServerResponse(patch)) return patch;
          yield* analytics.track({
            name: "patch.deleted",
            principalId: identity.user.id,
            properties: { patchId: params.patchId }
          });
          return new Deleted({
            ok: true,
            patchId: patch.id,
            state: "deleted",
            deletedAt: patch.deletedAt!,
            purgeAt: patch.purgeAt!
          });
        })
      );
  })
);
