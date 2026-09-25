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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { contentHash, newInternalId, newPatchId } from "@patchy/core";
import { ContentStore } from "@patchy/content-store";
import * as Patches from "./Patches.js";

export interface PublishInput extends Omit<
  Patches.RecordInput,
  | "intent"
  | "patchId"
  | "versionId"
  | "objectKey"
  | "contentHash"
  | "fileSize"
  | "serverObjectKey"
  | "serverHash"
> {
  readonly patchId: string | null;
  readonly html: string;
  /** PROTOTYPE for #314: the tier 2 server bundle, stored beside the HTML. */
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
      | SqlError
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
    /** PROTOTYPE for #314: the exact server bundle bytes a version recorded. */
    readonly readServer: (
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
    const patchId = input.patchId ?? newPatchId();
    const versionId = newInternalId("ver");
    const key = objectKey(patchId, versionId);
    const target = {
      intent: input.patchId === null ? "create" : "update",
      patchId,
      ownerUserId: input.ownerUserId
    } satisfies Patches.PublishTarget;

    const serverKey = input.server === undefined ? undefined : serverObjectKey(patchId, versionId);
    yield* patches.preflight({ ...input, ...target });
    yield* patches.prepareObject(key).pipe(
      Effect.andThen(store.put(key, input.html)),
      // PROTOTYPE for #314: the second artifact gets its own intent and put.
      Effect.andThen(
        serverKey === undefined || input.server === undefined
          ? Effect.void
          : patches
              .prepareObject(serverKey)
              .pipe(Effect.andThen(store.put(serverKey, input.server)))
      ),
      // Together with record's 60-second deadline, this stays inside the
      // five-minute intent lease and leaves time for interrupted I/O to settle.
      Effect.timeout("60 seconds"),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(new ContentStore.StoreUnavailable({ operation: "put", key, cause }))
      })
    );
    return yield* patches.record({
      ...input,
      ...target,
      versionId,
      objectKey: key,
      contentHash: contentHash(input.html),
      fileSize: new TextEncoder().encode(input.html).length,
      ...(serverKey === undefined || input.server === undefined
        ? {}
        : { serverObjectKey: serverKey, serverHash: contentHash(input.server) })
    });
  });

  const read = Effect.fn("Content.read")((version: Patches.PatchVersion) =>
    store.get(version.objectKey).pipe(Effect.catchTags({ ObjectNotFound: Effect.die }))
  );
  const readServer = Effect.fn("Content.readServer")((version: Patches.PatchVersion) =>
    version.serverObjectKey === null
      ? Effect.die(new Error("This version has no server bundle."))
      : store.get(version.serverObjectKey).pipe(Effect.catchTags({ ObjectNotFound: Effect.die }))
  );

  return Content.of({ publish, read, readServer });
});

/** Over `Patches` and the content store. */
export const layer = Layer.effect(Content, make);
