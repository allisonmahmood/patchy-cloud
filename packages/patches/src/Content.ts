/**
 * The one place a patch's bytes are touched on the way in and the way out:
 * the publish contract, and the read a served page is built from. Everything
 * else in the capability handles rows; `DeletionSweep` reclaims unreachable
 * objects through durable pending-object intents.
 *
 * Register an intent, put the object, then consume the intent and record the
 * version in one transaction. No database lock spans the object write.
 * Failures retain the intent for reclamation after its lease; a transaction
 * that committed despite a lost response consumes it and preserves the bytes.
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as WideEvents from "@patchy/analytics/wide-events";
import { contentHash, newInternalId, newPatchId, sha256 } from "@patchy/core";
import { ContentStore } from "@patchy/content-store";
import { HandlerDescriptors, WIRE_VERSION } from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import * as Inspection from "@patchy/execution/inspection";
import { DeploymentConfig } from "@patchy/limits";
import { Runtime, ServerBundles } from "@patchy/runtime";
import * as Patches from "./Patches.js";

const sameHandlers = Schema.toEquivalence(HandlerDescriptors);

export class InvalidManifest extends Schema.TaggedError<InvalidManifest>()("InvalidManifest", {
  reason: Schema.Literals([
    "server_missing",
    "server_unexpected",
    "descriptors",
    "inspection",
    "wire"
  ]),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Invalid server manifest: ${this.reason}.`;
  }
}

export class StoredServerUnavailable extends Schema.TaggedError<StoredServerUnavailable>()(
  "StoredServerUnavailable",
  { patchId: Schema.String, versionId: Schema.String }
) {
  override get message() {
    return `The retained server artifact for ${this.patchId}/${this.versionId} is unavailable.`;
  }
}
export interface PublishInput extends Omit<
  Patches.RecordInput,
  "intent" | "patchId" | "versionId" | "objectKey" | "contentHash" | "fileSize" | "server"
> {
  readonly patchId: string | null;
  readonly html: string;
  readonly server?: string | undefined;
}

export class Content extends Context.Service<
  Content,
  {
    /**
     * Stores the document and records the version, creating the patch when
     * `patchId` is null. Failed attempts leave a durable reclamation intent,
     * never an untracked object or a version whose bytes the sweep can claim.
     */
    readonly publish: (
      input: PublishInput
    ) => Effect.Effect<
      Patches.Recorded,
      | Patches.PatchUnavailable
      | Patches.PatchConflict
      | Patches.NameTaken
      | Patches.PublishKeyTaken
      | Patches.PatchQuotaReached
      | Patches.PendingObjectExpired
      | Patches.ResourceError
      | Patches.LifecycleError
      | Patches.Tier2NotPublic
      | SqlError
      | InvalidManifest
      | ContentStore.InvalidObjectKey
      | ContentStore.StoreUnavailable
    >;
    /**
     * Reads the bytes of a version whose metadata the caller has already loaded
     * and authorized. A missing recorded object is a fault, not an absence.
     */
    readonly read: (
      version: Patches.PatchVersion
    ) => Effect.Effect<string, ContentStore.InvalidObjectKey | ContentStore.StoreUnavailable>;
  }
>()("@patchy/patches/Content") {}

/** Where a version's bytes go. */
export const objectKey = (patchId: string, versionId: string) =>
  `patches/${patchId}/versions/${versionId}.html`;

export const serverObjectKey = (patchId: string, versionId: string) =>
  `patches/${patchId}/versions/${versionId}.server.js`;
export const make = Effect.gen(function* () {
  const patches = yield* Patches.Patches;
  const store = yield* ContentStore.ContentStore;

  const publish = Effect.fn("Content.publish")(function* (input: PublishInput) {
    if (input.manifest.tier === 2) {
      if (input.server === undefined)
        return yield* new InvalidManifest({ reason: "server_missing" });
      if (input.wireVersion !== WIRE_VERSION || input.wireVersion !== GuestProtocol.wireVersion)
        return yield* new InvalidManifest({ reason: "wire" });
    } else if (
      input.server !== undefined ||
      Object.keys(input.manifest.handlers ?? {}).length > 0
    ) {
      return yield* new InvalidManifest({ reason: "server_unexpected" });
    }
    const patchId = input.patchId ?? newPatchId();
    const versionId = newInternalId("ver");
    const key = objectKey(patchId, versionId);
    const target = {
      intent: input.patchId === null ? "create" : "update",
      patchId,
      ownerUserId: input.ownerUserId
    } satisfies Patches.PublishTarget;

    yield* patches.preflight({ ...input, ...target });
    const put = Effect.fn("Content.put")(function* (objectKey: string, bytes: string) {
      yield* patches.prepareObject(objectKey);
      yield* store.put(objectKey, bytes).pipe(
        // Each bounded write and record's deadline stay inside the five-minute intent lease.
        Effect.timeout("60 seconds"),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(
              new ContentStore.StoreUnavailable({ operation: "put", key: objectKey, cause })
            )
        })
      );
    });
    yield* put(key, input.html);
    let server: Patches.RecordInput["server"];
    if (input.server !== undefined) {
      const objectKey = serverObjectKey(patchId, versionId);
      yield* put(objectKey, input.server);
      const stored = yield* store
        .get(objectKey)
        .pipe(Effect.catchTags({ ObjectNotFound: Effect.die }));
      const handlers = yield* Inspection.inspect(stored).pipe(
        Effect.mapError((cause) => new InvalidManifest({ reason: "inspection", cause }))
      );
      if (!sameHandlers(handlers, input.manifest.handlers ?? {}))
        return yield* new InvalidManifest({ reason: "descriptors" });
      server = {
        objectKey,
        sha256: sha256(stored),
        bytes: Buffer.byteLength(stored, "utf8")
      };
    }
    return yield* patches.record({
      ...input,
      server,
      ...target,
      versionId,
      objectKey: key,
      contentHash: contentHash(input.html),
      fileSize: Buffer.byteLength(input.html, "utf8")
    });
  });

  const read = Effect.fn("Content.read")((version: Patches.PatchVersion) =>
    store.get(version.objectKey).pipe(Effect.catchTags({ ObjectNotFound: Effect.die }))
  );

  return Content.of({ publish, read });
});

/** Over `Patches` and the content store. */
export const layer = Layer.effect(Content, make);

/** A retained version's server artifact, with the version a failure names. */
type StoredServer = NonNullable<Patches.PatchVersion["server"]> & {
  readonly patchId: string;
  readonly versionId: string;
};

/**
 * Verified server bundles in memory by artifact identity, object key and digest,
 * whose stored bytes never change. Least recently used go first past either
 * `tier2.bundleCache.*` bound, and a bundle over a quarter of the byte bound is
 * never kept. Simultaneous misses share one read; failures, a hash mismatch
 * included, are never kept. Callers check retention before every load.
 */
const makeBundleCache = Effect.gen(function* () {
  const store = yield* ContentStore.ContentStore;
  const deployment = yield* DeploymentConfig.load;
  const maxBytes = deployment.get("tier2.bundleCache.bytes");
  const maxEntries = deployment.get("tier2.bundleCache.entries");
  // Insertion order is recency: a hit moves its entry to the end.
  const kept = new Map<string, { readonly bundle: string; readonly bytes: number }>();
  let keptBytes = 0;
  const identity = (stored: StoredServer) => `${stored.objectKey}#${stored.sha256}`;
  /** The kept bundle, now the most recently used, recorded as the call's `cached` load. */
  const recall = (key: string) =>
    Effect.suspend(() => {
      const hit = kept.get(key);
      if (hit === undefined) return Effect.undefined;
      kept.delete(key);
      kept.set(key, hit);
      return Effect.as(WideEvents.enrich({ bundleLoad: "cached" }), hit.bundle);
    });
  const keep = (key: string, bundle: string, bytes: number) => {
    if (bytes > maxBytes / 4) return;
    // Replacing an entry releases its bytes and moves it to the end.
    keptBytes -= kept.get(key)?.bytes ?? 0;
    kept.delete(key);
    kept.set(key, { bundle, bytes });
    keptBytes += bytes;
    for (const [oldest, entry] of kept) {
      if (keptBytes <= maxBytes && kept.size <= maxEntries) break;
      kept.delete(oldest);
      keptBytes -= entry.bytes;
    }
  };
  // A zero lifetime keeps no result here: this only joins simultaneous misses to one read.
  const reads = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    timeToLive: Duration.zero,
    lookup: Effect.fnUntraced(function* (stored: StoredServer) {
      const key = identity(stored);
      // A miss can arrive here just after another call's read settled and kept the bundle.
      const settled = yield* recall(key);
      if (settled !== undefined) return settled;
      yield* WideEvents.enrich({ bundleLoad: "read" });
      const bundle = yield* store.get(stored.objectKey);
      if (sha256(bundle) !== stored.sha256)
        return yield* new StoredServerUnavailable({
          patchId: stored.patchId,
          versionId: stored.versionId
        });
      keep(key, bundle, stored.bytes);
      return bundle;
    })
  });
  return Effect.fnUntraced(function* (stored: StoredServer) {
    const hit = yield* recall(identity(stored));
    if (hit !== undefined) return hit;
    // The lookup runs in the context of the call that starts it and relabels that call.
    yield* WideEvents.enrich({ bundleLoad: "joined" });
    return yield* Cache.get(reads, stored);
  });
});

/**
 * Loads only the retained artifact admitted by Runtime, never the HTML document.
 * Every load rechecks retention, company and wire version; only the read and its
 * hash come from memory.
 */
export const serverBundlesLayer = Layer.effect(
  ServerBundles.ServerBundles,
  Effect.gen(function* () {
    const patches = yield* Patches.Patches;
    const bundles = yield* makeBundleCache;
    return ServerBundles.ServerBundles.of({
      load: Effect.fn("Content.loadServer")(
        function* (loaded) {
          const found = yield* patches.findRetained(loaded.patchId, undefined, loaded.versionId);
          if (
            Option.isNone(found) ||
            found.value.patch.companyId !== loaded.companyId ||
            found.value.version.wireVersion !== GuestProtocol.wireVersion ||
            found.value.version.server === null
          )
            return yield* new StoredServerUnavailable({
              patchId: loaded.patchId,
              versionId: loaded.versionId
            });
          const artifact = found.value.version.server;
          const bundle = yield* bundles({
            ...artifact,
            patchId: loaded.patchId,
            versionId: loaded.versionId
          });
          return {
            companyId: loaded.companyId,
            patchId: loaded.patchId,
            versionId: loaded.versionId,
            sha256: artifact.sha256,
            bundle
          };
        },
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
      )
    });
  })
);
