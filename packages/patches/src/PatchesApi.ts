/**
 * The `patches` group of the Patchy API, implemented over `Content`,
 * `Patches` and `Limits`: discovery, publish, owner lifecycle actions and the
 * patch's log, read through Runtime's `InvocationLog`. The
 * identity comes from the bearer middleware the group declares; this
 * package never authenticates anyone.
 * The hosting server mounts the group with the rest of the API.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  BadRequest,
  Behind,
  Conflict,
  CurrentIdentity,
  decodeBody,
  DescriptionRequest,
  ForceRequest,
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
  Tier2NotPublic,
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
  LogEntry,
  LOG_PAGE_DEFAULT,
  PatchLog,
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
  AlreadyMember,
  GuestRemoved,
  GuestRequest,
  GuestShared,
  GuestsUnavailable,
  NotOnPatchy,
  PatchGuest,
  PatchGuests,
  Manifest,
  PublishRequest,
  PublishRefused,
  PublishKeyConflict,
  type PublishMetadata,
  MANIFEST_VERSION,
  WIRE_VERSION,
  agentToolEntries,
  base64Bytes,
  NoRepo,
  PatchRepo,
  repoLimits,
  repoTreeProblem,
  usesRefusal,
  type HandlerDescriptors,
  type RepoFile
} from "@patchy/api";
import { Companies, Looks, Users } from "@patchy/companies";
import { Cryptography, documentTitle } from "@patchy/core";
import { ConnectionStore } from "@patchy/integrations";
import { Limits } from "@patchy/limits";
import { InvocationLog } from "@patchy/runtime";
import * as Content from "./Content.js";
import * as GuestGrants from "./GuestGrants.js";
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
const encodeLog = Schema.encodeSync(PatchLog);
const encodeRepo = Schema.encodeSync(PatchRepo);

/**
 * What `patchy pull` gets from a version: its snapshot, a file-born page's one file, or nothing.
 * A file publish records its filename and sends tier 1 with no server module, tables or stores.
 * Filename metadata on anything else is the client's say-so, and its HTML alone isn't the patch.
 */
const pullKind = (version: Patches.PatchVersion) =>
  version.repo !== null
    ? ("repo" as const)
    : version.originalFilename !== null &&
        version.tier === 1 &&
        version.server === null &&
        Object.keys(version.manifest.tables).length === 0 &&
        Object.keys(version.manifest.files).length === 0
      ? ("file" as const)
      : null;

/**
 * A file-born page's original filename as a name safe to write anywhere, ending in `.html`.
 * Filenames are client metadata, so nothing of a folder, a leading dot or an odd character stays.
 */
const pageFilename = (original: string | null) => {
  const stem = (original ?? "")
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.html?$/i, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/^[.\s-]+|[.\s]+$/g, "")
    .slice(0, 100);
  return `${stem === "" ? "index" : stem}.html`;
};
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
const primitiveSummary = (
  row: Patches.ReadPatch,
  name: string,
  definition: { readonly description: string; readonly shared?: boolean },
  kind: "table" | "store"
): typeof PatchTableSummary.Type => {
  const common = { name, description: definition.description, shared: definition.shared === true };
  if (row.patch.state !== "live") {
    return {
      ...common,
      declarable: false,
      reason: "source_off",
      hint: `This source is ${row.patch.state}. Ask ${row.owner.name} or an admin to restore it.`
    };
  }
  return definition.shared
    ? {
        ...common,
        declarable: true,
        hint: `patchy add shared-${kind} ${row.patch.id}/${name}`
      }
    : {
        ...common,
        declarable: false,
        reason: "not_shared",
        hint: `Not shared. Ask ${row.owner.name} to share this ${kind}.`
      };
};
const lifecycleFailure = <S extends Schema.Top & Schema.Codec<{ readonly code: string }, unknown>>(
  schema: S,
  code: S["Type"]["code"],
  fields: Omit<S["~type.make.in"], "ok" | "code">
) => Effect.succeed(refuse(schema, { ok: false, code, ...fields }));
const lifecycleFailures = {
  NotOwner: (error: Patches.NotOwner) =>
    lifecycleFailure(NotOwner, "not_owner", { error: error.message, owner: error.owner }),
  WrongState: (error: Patches.WrongState) =>
    lifecycleFailure(WrongState, "wrong_state", { error: error.message, state: error.state }),
  PatchRetired: (error: Patches.PatchRetired) =>
    lifecycleFailure(PatchRetired, "patch_retired", { error: error.message }),
  PatchDeleted: (error: Patches.PatchDeleted) =>
    lifecycleFailure(PatchDeleted, "patch_deleted", {
      error: error.message,
      purgeAt: error.purgeAt
    }),
  HasDependants: (error: Patches.HasDependants) =>
    lifecycleFailure(HasDependants, "has_dependants", {
      error: error.message,
      dependants: error.dependants
    }),
  SourcesOff: (error: Patches.SourcesOff) =>
    lifecycleFailure(SourcesOff, "sources_off", { error: error.message, sources: error.sources }),
  ReservedName: (error: Patches.ReservedName) =>
    lifecycleFailure(ReservedName, "reserved_name", { error: error.message }),
  InvalidDescription: (error: Patches.InvalidDescription) =>
    lifecycleFailure(InvalidDescription, "invalid_description", { error: error.message }),
  VersionUnavailable: (error: Patches.VersionUnavailable) =>
    lifecycleFailure(VersionUnavailable, "version_unavailable", { error: error.message }),
  InvalidOwner: Effect.die,
  // Machine-token calls carry no portal precondition.
  StaleAction: Effect.die
};
const tierFailures = {
  Tier2NotPublic: (error: Patches.Tier2NotPublic) =>
    lifecycleFailure(Tier2NotPublic, "tier2_not_public", { error: error.message })
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

/** A patch's guest as the wire names them. */
const patchGuest = (guest: GuestGrants.Guest) =>
  new PatchGuest({
    userId: guest.userId,
    name: guest.name,
    email: guest.email,
    company: { name: guest.companyName },
    grantedAt: guest.grantedAt.toISOString()
  });
/** Who may manage the patch: the owner check every guest act makes first. */
const managerFailures = {
  NotOwner: lifecycleFailures.NotOwner,
  PatchUnavailable: ownerFailures.PatchUnavailable,
  SqlError: Effect.die
};
/** Share's refusals: a patch that isn't live, guests can't open, or someone who can't be its guest. */
const shareFailures = {
  WrongState: lifecycleFailures.WrongState,
  NotOnPatchy: (error: GuestGrants.NotOnPatchy) =>
    lifecycleFailure(NotOnPatchy, "not_on_patchy", { error: error.message }),
  AlreadyMember: (error: GuestGrants.AlreadyMember) =>
    lifecycleFailure(AlreadyMember, "already_member", { error: error.message }),
  GuestsUnavailable: (error: GuestGrants.GuestsUnavailable) =>
    lifecycleFailure(GuestsUnavailable, "guests_unavailable", {
      error: error.message,
      reason: error.reason
    }),
  ConnectionStorageFailed: Effect.die
};

/** A log page stops before passing this many bytes, so one noisy patch can't flood an agent. */
const LOG_PAGE_BYTES = 2 * 1024 * 1024;

/** Stored ids in the reader's words: version numbers, people's names and connection handles. */
interface LogNames {
  readonly versions: ReadonlyMap<string, number>;
  readonly people: ReadonlyMap<string, string>;
  readonly connections: ReadonlyMap<string, string>;
}

const logEntry = ({ invocation, tree, truncated }: InvocationLog.Entry, names: LogNames) =>
  ({
    id: invocation.id,
    correlationId: invocation.correlationId,
    startedAt: invocation.startedAt.toISOString(),
    settledAt: invocation.settledAt?.toISOString() ?? null,
    version: names.versions.get(invocation.versionId) ?? null,
    handler: invocation.handler,
    kind: invocation.kind,
    viewer: {
      id: invocation.initiatingViewerId,
      name: names.people.get(invocation.initiatingViewerId) ?? null
    },
    agent: invocation.agent,
    outcome: invocation.outcome,
    code: invocation.outcomeCode,
    durationMs: invocation.durationMs,
    guestMs: invocation.guestMs,
    dbMs: invocation.dbMs,
    callbacks: invocation.callbacks,
    attempts: invocation.attempts,
    replyDelivered: invocation.replyDelivered,
    logLines: invocation.logLines,
    steps: tree.map((step) => ({
      type: step.type,
      id: step.id,
      parentId: step.parentId,
      at: step.at.toISOString(),
      name: step.name,
      kind: step.kind,
      resource: step.resource,
      connection:
        step.connectionId === null
          ? null
          : (names.connections.get(step.connectionId) ?? step.connectionId),
      effectivePrincipal: step.effectivePrincipal,
      outcome: step.outcome,
      code: step.outcomeCode,
      durationMs: step.durationMs,
      attempts: step.attempts,
      rowCount: step.rowCount,
      logLines: step.logLines
    })),
    stepsTruncated: truncated
  }) satisfies LogEntry;

/**
 * Keeps entries, newest first, until the next would pass `LOG_PAGE_BYTES`; the first always stays.
 * A cut page continues from its last kept entry, inside the same filter window.
 */
const boundLogPage = (
  entries: ReadonlyArray<LogEntry>,
  page: { readonly next: string | null; readonly windowEnded: boolean }
) => {
  const kept: LogEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (kept.length > 0 && bytes > LOG_PAGE_BYTES) break;
    kept.push(entry);
  }
  return kept.length < entries.length
    ? { entries: kept, next: kept.at(-1)!.id, windowEnded: false }
    : { entries: kept, next: page.next, windowEnded: page.windowEnded };
};

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
/** A manifest from before tier 0's pages became tier 1, which names the fix rather than failing to decode. */
const isTierZero = Schema.is(Schema.Struct({ tier: Schema.Literal(0) }));
/** A replayed publish names the patch and version it created, like the first answer. */
const decodeReplayIds = Schema.decodeUnknownOption(
  Schema.Struct({ patchId: Schema.String, versionId: Schema.String })
);
const decodeShare = decodeBody(ShareRequest);
const decodeGuest = decodeBody(GuestRequest);
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
          : refusal.field === "repo"
            ? "Invalid repo snapshot: each file needs a relative path without empty, . or .. segments, backslashes or control characters, and padded base64 contents."
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

/**
 * A manifest-wide check's own words, such as a row naming a table the patch doesn't define;
 * a malformed field stays "Invalid manifest.".
 */
const manifestRefusal = (error: Schema.SchemaError) =>
  error.issue._tag === "Composite" && error.issue.issues.every((issue) => issue._tag === "Filter")
    ? error.message
    : "Invalid manifest.";

/** Ends `text` with a full stop unless it already ends a sentence. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Where the publication came from, as far as the request says. */
const requestOrigin = Effect.map(HttpServerRequest.HttpServerRequest, (request) => ({
  sourceIp: Option.getOrNull(request.remoteAddress),
  userAgent: request.headers["user-agent"] ?? null
}));

export const layer = HttpApiBuilder.group(PatchyApi, "patches", (handlers) =>
  Effect.gen(function* () {
    const cryptography = yield* Cryptography.Cryptography;
    const content = yield* Content.Content;
    const patches = yield* Patches.Patches;
    const openability = yield* Patches.Openability;
    const limits = yield* Limits.Limits;
    const looks = yield* Looks.Looks;
    const companies = yield* Companies.Companies;
    const invocationLog = yield* InvocationLog.InvocationLog;
    const users = yield* Users.Users;
    const connectionStore = yield* ConnectionStore.ConnectionStore;
    const guestGrants = yield* GuestGrants.GuestGrants;
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    const maxBundleBytes = yield* PatchesConfig.maxBundleBytes;
    const createRateLimitPerMinute = yield* PatchesConfig.patchCreateRateLimitPerMinute;
    const publishRateLimitPerMinute = yield* PatchesConfig.publishRateLimitPerMinute;
    const maxPublishBodyBytes = yield* PatchesConfig.maxPublishBodyBytes;
    // Bundles widen only publish; owner actions carry a few fields and keep a small cap of their own.
    const maxShareBodyBytes = 1536 * 1024;
    const currentRelease = yield* PatchesConfig.release;
    const livePatchesPerUser = yield* PatchesConfig.livePatchesPerUser;
    const tier2Enabled = yield* PatchesConfig.tier2Enabled;

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
      if (HttpServerResponse.isHttpServerResponse(rows)) return rows;
      const row = rows[0];
      if (row === undefined) return notFound();
      yield* WideEvents.enrich(Patches.eventFields(row.patch));
      return row;
    });

    /**
     * A repo publish ships the look its page builds in and never a newer one, so it hears when
     * that isn't the company's current look, and how to catch up. Advisory: a failed read warns
     * too. An absent stamp checks nothing.
     */
    const lookWarnings = Effect.fn("PatchesApi.lookWarnings")(function* (
      own: PublishMetadata["look"],
      company: CurrentIdentity["Service"]["company"]
    ) {
      if (own === undefined) return [];
      return yield* looks.current(company.id).pipe(
        Effect.map((current) => {
          // Revision numbers restart in every company, so a revision is its number and its time.
          const same =
            own === null || current === null
              ? own === current
              : own.revision === current.revision &&
                Date.parse(own.createdAt) === current.createdAt.getTime();
          if (same) return [];
          const has =
            own === null ? "the Patchy look" : `${company.name}'s look rev ${own.revision}`;
          const now =
            current === null
              ? `${company.name} has no look now.`
              : `the current look is rev ${current.revision} by ${current.author.name}: ${sentence(current.note)}`;
          return [
            `This repo has ${has}, but ${now} This version keeps the repo's look; run patchy refresh to bring it up to date.`
          ];
        }),
        Effect.catchTags({
          SqlError: (error) =>
            Effect.logWarning("Publish could not read the company look.", error).pipe(
              Effect.annotateLogs({ companyId: company.id }),
              Effect.as([
                "Could not check whether this repo's look is current: The look could not be read."
              ])
            )
        })
      );
    });

    /**
     * A version with agent tools hears when its company's agent access is off, since no agent
     * can use them until an admin turns it on. Advisory, like the look check.
     */
    const agentAccessWarnings = Effect.fn("PatchesApi.agentAccessWarnings")(function* (
      handlers: HandlerDescriptors | undefined,
      company: CurrentIdentity["Service"]["company"]
    ) {
      if (agentToolEntries(handlers).length === 0) return [];
      return yield* companies.agentAccess(company.id).pipe(
        Effect.map((access) =>
          access.on
            ? []
            : [
                `Agent access is off at ${company.name}, so no agent can use these agent tools yet. An admin turns it on at ${publicBaseUrl.replace(/\/+$/, "")}/company/agent-access.`
              ]
        ),
        Effect.catchTags({
          CompanyNotFound: Effect.die,
          SqlError: (error) =>
            Effect.logWarning("Publish could not read agent access.", error).pipe(
              Effect.annotateLogs({ companyId: company.id }),
              Effect.as([`Could not check whether agent access is on at ${company.name}.`])
            )
        })
      );
    });

    /**
     * Why the patch's guests can't open the version it publishes, when it has any: the publish
     * still succeeds, and says so here.
     */
    const guestWarnings = Effect.fn("PatchesApi.guestWarnings")(function* (
      patchId: string | null,
      scope: PublishRequest["scope"],
      manifest: typeof Manifest.Type,
      company: CurrentIdentity["Service"]["company"]
    ) {
      if (patchId === null) return [];
      const couldNotCheck = (error: unknown) =>
        Effect.logWarning("Publish could not read whether guests can open the patch.", error).pipe(
          Effect.annotateLogs({ companyId: company.id, patchId }),
          Effect.as(["Could not check whether this patch's guests can open this version."])
        );
      return yield* guestGrants
        .unavailableAfterPublish({
          patchId,
          companyId: company.id,
          scope,
          version: { tier: manifest.tier, manifest }
        })
        .pipe(
          Effect.map(
            Option.match({ onNone: () => [], onSome: (reason) => [GuestGrants.warning(reason)] })
          ),
          Effect.catchTags({ SqlError: couldNotCheck, ConnectionStorageFailed: couldNotCheck })
        );
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
          const digest = yield* cryptography.contentHash(canonicalJson(json));
          const replay = Effect.fn("PatchesApi.replay")(function* () {
            const stored = yield* patches
              .replay(identity.user.id, key.publishKey)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (Option.isNone(stored)) return undefined;
            if (stored.value.payloadDigest !== digest) return keyConflict();
            const published = decodeReplayIds(stored.value.response);
            if (Option.isSome(published)) yield* WideEvents.enrich(published.value);
            return HttpServerResponse.text(stored.value.body, {
              status: stored.value.status,
              contentType: "application/json"
            });
          });
          const previous = yield* replay();
          if (previous !== undefined) return previous;
          if (isPatchId(key.patchId)) {
            yield* WideEvents.enrich({ patchId: key.patchId });
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
                // The instance cannot tell a repo publish from a global CLI's file publish.
                `Release ${release.manifest.release} does not match instance release ${currentRelease}. In a patch repo, run pnpm patchy refresh; otherwise upgrade the CLI with the installer at ${publicBaseUrl.replace(/\/+$/, "")}/llms.txt.`
              )
            );
          }
          if (isTierZero(key.manifest))
            return rejected(
              "tier_mismatch",
              "Tier 0 is now tier 1. Publish with a tier 1 manifest; a current patchy CLI sends one."
            );
          const manifest = yield* decodeManifest(key.manifest).pipe(
            Effect.catch((error) =>
              Effect.succeed(rejected("invalid_manifest", manifestRefusal(error)))
            )
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
          if (manifest.tier > 2) return rejected("tier_mismatch", "Tier 3 is not served yet.");
          if (manifest.tier === 2 && !tier2Enabled)
            return rejected("tier_mismatch", "Tier 2 requires the fleet executor in production.");
          if (manifest.tier < 2 && payload.server !== undefined)
            return rejected("tier_mismatch", "Server code requires tier 2.");
          const lowerTierUses = usesRefusal(manifest.tier, Object.keys(manifest.uses));
          if (lowerTierUses !== undefined) return rejected("tier_mismatch", lowerTierUses);
          if (manifest.tier === 2 && payload.server === undefined)
            return rejected("invalid_manifest", "Tier 2 requires a server artifact.");
          const serverBytes =
            payload.server === undefined ? 0 : Buffer.byteLength(payload.server, "utf8");
          if (serverBytes > maxBundleBytes)
            return refuse(PayloadTooLarge, {
              ok: false,
              error: `Server bundle is ${serverBytes} bytes; maximum is ${maxBundleBytes} bytes.`
            });
          if (payload.repo !== undefined) {
            const files = payload.repo.length;
            const repoBytes = payload.repo.reduce(
              (total, file) => total + base64Bytes(file.contents),
              0
            );
            if (files > repoLimits.files || repoBytes > repoLimits.bytes)
              return refuse(PayloadTooLarge, {
                ok: false,
                error:
                  files > repoLimits.files
                    ? `Repo snapshot has ${files} files; publish.repo.files is ${repoLimits.files}.`
                    : `Repo snapshot holds ${repoBytes} bytes; publish.repo.bytes is ${repoLimits.bytes}.`
              });
            const problem = repoTreeProblem(payload.repo.map((file) => file.path));
            if (problem !== undefined)
              return refuse(BadRequest, { ok: false, error: `Invalid repo snapshot: ${problem}` });
          }
          const bytes = Buffer.byteLength(payload.html, "utf8");
          if (bytes > maxBundleBytes)
            return refuse(PayloadTooLarge, {
              ok: false,
              error: `HTML bundle is ${bytes} bytes; maximum is ${maxBundleBytes} bytes.`
            });
          const title = documentTitle(payload.html) ?? (manifest.name || "Untitled Patch");
          const warnings: string[] = [];
          if (manifest.tier === 2 && Object.keys(manifest.handlers ?? {}).length === 0)
            warnings.push("Tier 2 has no handlers.");
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
          // Before the version is recorded, so the stored response a same-key retry replays has it.
          warnings.push(...(yield* lookWarnings(metadata.look, identity.company)));
          warnings.push(...(yield* agentAccessWarnings(manifest.handlers, identity.company)));
          warnings.push(
            ...(yield* guestWarnings(patchId, payload.scope, manifest, identity.company))
          );
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
              server: payload.server,
              repo: payload.repo,
              baseVersion: payload.baseVersion,
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
                ...tierFailures,
                PatchUnavailable: () => replayOrRespond(notFound()),
                PatchConflict: () =>
                  replayOrRespond(refuse(Conflict, { ok: false, error: "Patch already exists." })),
                NameTaken: (error) =>
                  replayOrRespond(
                    refuse(NameTaken, { ok: false, code: "name_taken", error: error.message })
                  ),
                PublishKeyTaken: () => replayOrRespond(keyConflict()),
                Behind: (error) =>
                  replayOrRespond(
                    refuse(Behind, {
                      ok: false,
                      code: "behind",
                      error: `${error.message} Pull it into a new folder with patchy pull and make the change there, or publish again with --allow-behind to replace it.`,
                      baseVersion: error.baseVersion,
                      latestVersion: error.latestVersion,
                      publishedBy: error.publishedBy,
                      publishedAt: error.publishedAt
                    })
                  ),
                PatchQuotaReached: () => replayOrRespond(quotaResponse()),
                InvalidManifest: (error) =>
                  replayOrRespond(rejected("invalid_manifest", error.message)),
                InvalidHandlerDescription: (error) =>
                  replayOrRespond(rejected("invalid_manifest", error.message)),
                InvalidAgentArea: (error) =>
                  replayOrRespond(rejected("invalid_manifest", error.message)),
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
          yield* WideEvents.enrich({ patchId: recorded.patchId, versionId: recorded.versionId });
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
          const inventory = yield* patches
            .companyInventory(row.patch.id, {
              companyId: identity.company.id,
              userId: identity.user.id,
              canOpen: (patch) => openability(patch, identity.user.id)
            })
            .pipe(
              Effect.catchTags({
                PatchUnavailable: readFailures.PatchUnavailable,
                SqlError: Effect.die
              })
            );
          if (HttpServerResponse.isHttpServerResponse(inventory)) return inventory;
          const current = yield* patches
            .findRetained(row.patch.id)
            .pipe(Effect.catchTags({ SqlError: Effect.die }));
          const version = Option.getOrUndefined(current)?.version;
          const kind = version === undefined ? null : pullKind(version);
          return HttpServerResponse.jsonUnsafe(
            encodeDetail(
              new PatchDetail({
                ...summary(row, identity.user.id, publicBaseUrl),
                title: row.patch.title,
                descriptionUpdatedAt: row.patch.descriptionUpdatedAt,
                inventory:
                  inventory === null
                    ? null
                    : {
                        tables: Object.entries(inventory.tables).map(([name, table]) =>
                          primitiveSummary(row, name, table, "table")
                        ),
                        stores: Object.entries(inventory.files).map(([name, store]) =>
                          primitiveSummary(row, name, store, "store")
                        )
                      },
                reads: row.reads,
                repo:
                  version === undefined || kind === null
                    ? null
                    : {
                        versionNumber: version.versionNumber,
                        kind,
                        ...(version.repo === null
                          ? { files: 1, bytes: version.fileSize }
                          : { files: version.repo.files, bytes: version.repo.bytes })
                      }
              })
            ),
            { headers: readHeaders }
          );
        })
      )
      .handleRaw(
        "pull",
        Effect.fn("PatchesApi.pull")(
          function* ({ params, query }) {
            const identity = yield* CurrentIdentity;
            const row = yield* readOne(params.patchRef, query.state ?? "live", identity);
            if (HttpServerResponse.isHttpServerResponse(row)) return row;
            const found = yield* patches
              .findRetained(row.patch.id, query.version)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (Option.isNone(found))
              return refuse(NotFound, {
                ok: false,
                error: `${row.patch.name} has no version ${query.version}.`
              });
            const { version } = found.value;
            yield* WideEvents.enrich({ versionId: version.id });
            const kind = pullKind(version);
            if (kind === null)
              return refuse(NoRepo, {
                ok: false,
                code: "no_repo",
                error: `Version ${version.versionNumber} of ${row.patch.name} was published without its repo, so there is nothing to pull. Its owner, ${row.owner.name}, keeps one by publishing again from their repo.`,
                versionNumber: version.versionNumber,
                owner: { id: row.owner.id, name: row.owner.name }
              });
            const files: ReadonlyArray<RepoFile> =
              version.repo === null
                ? [
                    {
                      path: pageFilename(version.originalFilename),
                      contents: Buffer.from(yield* content.read(version)).toString("base64")
                    }
                  ]
                : yield* content.readRepo(version.repo);
            return HttpServerResponse.jsonUnsafe(
              encodeRepo(
                new PatchRepo({
                  ok: true,
                  patchId: row.patch.id,
                  name: row.patch.name,
                  state: row.patch.state,
                  versionNumber: version.versionNumber,
                  tier: version.tier,
                  owner: { id: row.owner.id, name: row.owner.name },
                  description: row.patch.description,
                  descriptionUpdatedAt: row.patch.descriptionUpdatedAt,
                  kind,
                  files
                })
              ),
              { headers: readHeaders }
            );
          },
          Effect.catchTags({ InvalidObjectKey: Effect.die, StoreUnavailable: Effect.die })
        )
      )
      .handleRaw(
        "primitive",
        Effect.fn("PatchesApi.primitive")(function* ({ params, query }) {
          const identity = yield* CurrentIdentity;
          const row = yield* readOne(params.patchRef, query.state ?? "live", identity);
          if (HttpServerResponse.isHttpServerResponse(row)) return row;
          const inventory = yield* patches
            .companyInventory(row.patch.id, {
              companyId: identity.company.id,
              userId: identity.user.id,
              canOpen: (patch) => openability(patch, identity.user.id)
            })
            .pipe(
              Effect.catchTags({
                PatchUnavailable: readFailures.PatchUnavailable,
                SqlError: Effect.die
              })
            );
          if (HttpServerResponse.isHttpServerResponse(inventory)) return inventory;
          if (inventory === null) return databaseUnavailable();
          const table = Object.hasOwn(inventory.tables, params.name)
            ? inventory.tables[params.name]
            : undefined;
          const store = Object.hasOwn(inventory.files, params.name)
            ? inventory.files[params.name]
            : undefined;
          if (table === undefined && store === undefined)
            return refuse(NotFound, { ok: false, error: "Primitive not found." });
          return HttpServerResponse.jsonUnsafe(
            encodePrimitive(
              new PrimitiveDetail({
                kind: table === undefined ? "store" : "table",
                ...primitiveSummary(
                  row,
                  params.name,
                  (table ?? store)!,
                  table === undefined ? "store" : "table"
                ),
                schemaRevision: inventory.schemaRevision,
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
      .handleRaw(
        "log",
        Effect.fn("PatchesApi.log")(function* ({ params, query }) {
          const identity = yield* CurrentIdentity;
          if (!isPatchId(params.patchId)) return notFound();
          const card = yield* patches
            .portalCard(params.patchId, {
              companyId: identity.company.id,
              userId: identity.user.id,
              canOpen: (patch) => openability(patch, identity.user.id)
            })
            .pipe(
              Effect.catchTags({
                PatchUnavailable: () => Effect.succeed(notFound()),
                SqlError: Effect.die
              })
            );
          if (HttpServerResponse.isHttpServerResponse(card)) return card;
          yield* WideEvents.enrich(Patches.eventFields(card.patch));
          // Ownership is read now, so reassignment moves who may read the log, as in the portal.
          if (identity.role !== "admin" && card.owner.id !== identity.user.id)
            return refuse(NotOwner, {
              ok: false,
              code: "not_owner",
              error: `Only ${card.owner.name} or an admin can read this patch's log.`,
              owner: { id: card.owner.id, name: card.owner.name }
            });
          const page = yield* invocationLog
            .page({
              companyId: identity.company.id,
              patchId: card.patch.id,
              ...(query.before === undefined ? {} : { before: query.before }),
              filter: query.failed === true ? { outcome: "failed" } : {},
              limit: query.limit ?? LOG_PAGE_DEFAULT
            })
            .pipe(Effect.catchTags({ SqlError: Effect.die }));
          // Actors by name, the patch's guests from other companies included.
          const people = yield* users
            .names(page.entries.map((entry) => entry.invocation.initiatingViewerId))
            .pipe(Effect.catchTags({ SqlError: Effect.die }));
          // A connection deleted since, or a store that cannot answer, leaves the id.
          const connections = page.entries.some((entry) =>
            entry.tree.some((step) => step.connectionId !== null)
          )
            ? yield* connectionStore.list(identity.company.id).pipe(Effect.orElseSucceed(() => []))
            : [];
          const names: LogNames = {
            versions: new Map(card.versions.map((version) => [version.id, version.versionNumber])),
            people,
            connections: new Map(
              connections.map((connection) => [
                connection.id,
                `${connection.integration}/${connection.handle}`
              ])
            )
          };
          const bounded = boundLogPage(
            page.entries.map((entry) => logEntry(entry, names)),
            page
          );
          return HttpServerResponse.jsonUnsafe(
            encodeLog(new PatchLog({ ok: true, patchId: card.patch.id, ...bounded })),
            { headers: readHeaders }
          );
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
            .pipe(Effect.catchTags({ ...ownerFailures, ...tierFailures }));
          if (HttpServerResponse.isHttpServerResponse(shared)) return shared;
          yield* WideEvents.enrich(Patches.eventFields(shared));
          return new Shared({
            ok: true,
            patchId: params.patchId,
            scope: shared.scope,
            publicUrl: Patches.address(publicBaseUrl, shared.companyHandle, shared.name)
          });
        })
      )
      .handleRaw("listGuests", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const listed = yield* guestGrants
            .list({ patchId: params.patchId, actor: { userId: identity.user.id, admin: false } })
            .pipe(Effect.catchTags(managerFailures));
          if (HttpServerResponse.isHttpServerResponse(listed)) return listed;
          yield* WideEvents.enrich(Patches.eventFields(listed.patch));
          return new PatchGuests({
            ok: true,
            patchId: listed.patch.id,
            guests: listed.guests.map(patchGuest)
          });
        })
      )
      .handleRaw("addGuest", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const payload = yield* readBody(maxShareBodyBytes).pipe(
            Effect.flatMap(decodeGuest),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const shared = yield* guestGrants
            .share({
              patchId: params.patchId,
              actor: { userId: identity.user.id, admin: false },
              email: payload.email
            })
            .pipe(Effect.catchTags({ ...managerFailures, ...shareFailures }));
          if (HttpServerResponse.isHttpServerResponse(shared)) return shared;
          yield* WideEvents.enrich(Patches.eventFields(shared.patch));
          return new GuestShared({
            ok: true,
            patchId: shared.patch.id,
            address: Patches.address(publicBaseUrl, shared.patch.companyHandle, shared.patch.name),
            guest: patchGuest(shared.guest)
          });
        })
      )
      .handleRaw("removeGuest", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const removed = yield* guestGrants
            .remove({
              patchId: params.patchId,
              actor: { userId: identity.user.id, admin: false },
              guest: params.guest
            })
            .pipe(Effect.catchTags(managerFailures));
          if (HttpServerResponse.isHttpServerResponse(removed)) return removed;
          yield* WideEvents.enrich(Patches.eventFields(removed.patch));
          return new GuestRemoved({
            ok: true,
            patchId: removed.patch.id,
            removed: removed.removed
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
          yield* WideEvents.enrich(Patches.eventFields(patch));
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
          yield* WideEvents.enrich(Patches.eventFields(patch));
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
            .pipe(Effect.catchTags({ ...ownerFailures, ...tierFailures }));
          if (HttpServerResponse.isHttpServerResponse(result)) return result;
          yield* WideEvents.enrich(Patches.eventFields(result.patch));
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
          yield* WideEvents.enrich(Patches.eventFields(patch));
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
          yield* WideEvents.enrich(Patches.eventFields(patch));
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
