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
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
      version: Pick<Patches.PatchVersion, "objectKey">
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

  const read = Effect.fn("Content.read")((version: Pick<Patches.PatchVersion, "objectKey">) =>
    store.get(version.objectKey).pipe(Effect.catchTags({ ObjectNotFound: Effect.die }))
  );

  return Content.of({ publish, read });
});

/** Over `Patches` and the content store. */
export const layer = Layer.effect(Content, make);

/** Where a load got its artifact: memory, the read it started, or another load's read. */
export type ArtifactLoad = "cached" | "read" | "joined";

/**
 * Verified artifacts in memory by identity, for stored bytes that never change. Least
 * recently used go first past either bound, and an artifact whose recorded size is over a
 * quarter of the byte bound is never kept. Failures are never kept. This replaces only the
 * read: callers check admission before every load.
 *
 * A miss starts one job, which reads the artifact and keeps it. Simultaneous misses join it.
 * The job runs in the host's scope until it settles, even when every load waiting on it stops,
 * so a retry joins it or finds what it kept instead of starting the work again. A job not
 * settled within 30 seconds fails, so a hung read can't hold its identity.
 *
 * The server bundles below and Serving's content documents each make their own.
 */
export const makeArtifactCache = Effect.fnUntraced(function* <K, A, E>(options: {
  readonly maxBytes: number;
  readonly maxEntries: number;
  /** The same for the same stored bytes: the object key and its recorded digest. */
  readonly identity: (key: K) => string;
  /** The artifact's recorded size, known before the read. */
  readonly size: (key: K) => number;
  /**
   * Reads and verifies a missed artifact. `keep` says whether it will be kept, so a read can
   * skip work only a kept artifact repays; `bytes` is what the kept form holds.
   */
  readonly read: (
    key: K,
    keep: boolean
  ) => Effect.Effect<{ readonly value: A; readonly bytes: number }, E>;
  /** Labels the loading call's wide event with where it got the artifact. */
  readonly loaded: (load: ArtifactLoad) => Effect.Effect<void>;
}) {
  const { maxBytes, maxEntries, identity, size, read, loaded } = options;
  const scope = yield* Effect.scope;
  // Insertion order is recency: a hit moves its entry to the end.
  const kept = new Map<string, { readonly value: A; readonly bytes: number }>();
  let keptBytes = 0;
  /** Each miss in flight, until its job settles. */
  const jobs = new Map<string, Deferred.Deferred<A, E | Cause.TimeoutError>>();
  // A job only starts for an identity neither kept nor in flight, so it never replaces one.
  const keep = (id: string, value: A, bytes: number) => {
    kept.set(id, { value, bytes });
    keptBytes += bytes;
    for (const [oldest, entry] of kept) {
      if (keptBytes <= maxBytes && kept.size <= maxEntries) break;
      kept.delete(oldest);
      keptBytes -= entry.bytes;
    }
  };
  /**
   * Reads, then keeps and settles in one step however the read ends, so a load finds either
   * the job or its result.
   */
  const run = (key: K, id: string, job: Deferred.Deferred<A, E | Cause.TimeoutError>) => {
    const keeping = size(key) <= maxBytes / 4;
    return read(key, keeping).pipe(
      Effect.timeout("30 seconds"),
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          jobs.delete(id);
          if (keeping && Exit.isSuccess(exit)) keep(id, exit.value.value, exit.value.bytes);
          return Deferred.done(
            job,
            Exit.map(exit, (artifact) => artifact.value)
          );
        })
      )
    );
  };
  // Each load decides in one synchronous step: kept, joined or started. Only waiting is
  // interruptible, so a started job is always forked.
  return (key: K) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const id = identity(key);
        const hit = kept.get(id);
        if (hit !== undefined) {
          kept.delete(id);
          kept.set(id, hit);
          return Effect.as(loaded("cached"), hit.value);
        }
        const pending = jobs.get(id);
        if (pending !== undefined)
          return Effect.andThen(loaded("joined"), restore(Deferred.await(pending)));
        const job = Deferred.makeUnsafe<A, E | Cause.TimeoutError>();
        jobs.set(id, job);
        return loaded("read").pipe(
          // Interruptible again, so its deadline and the host's scope can stop it.
          Effect.andThen(Effect.forkIn(Effect.interruptible(run(key, id, job)), scope)),
          Effect.andThen(restore(Deferred.await(job)))
        );
      })
    );
});

/** A retained version's server artifact, with the version a failure names. */
type StoredServer = NonNullable<Patches.PatchVersion["server"]> & {
  readonly patchId: string;
  readonly versionId: string;
};

/**
 * Verified server bundles by artifact identity, object key and digest, within the
 * `tier2.bundleCache.*` bounds. A hash mismatch is a failure, so it is never kept.
 */
const makeBundleCache = Effect.gen(function* () {
  const store = yield* ContentStore.ContentStore;
  const deployment = yield* DeploymentConfig.load;
  return yield* makeArtifactCache({
    maxBytes: deployment.get("tier2.bundleCache.bytes"),
    maxEntries: deployment.get("tier2.bundleCache.entries"),
    identity: (stored: StoredServer) => `${stored.objectKey}#${stored.sha256}`,
    size: (stored) => stored.bytes,
    read: Effect.fnUntraced(function* (stored) {
      const bundle = yield* store.get(stored.objectKey);
      if (sha256(bundle) !== stored.sha256)
        return yield* new StoredServerUnavailable({
          patchId: stored.patchId,
          versionId: stored.versionId
        });
      return { value: bundle, bytes: stored.bytes };
    }),
    loaded: (bundleLoad) => WideEvents.enrich({ bundleLoad })
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
