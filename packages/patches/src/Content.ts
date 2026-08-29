/**
 * The one place a patch's bytes are touched on the way in and the way out:
 * the upload contract, and the read a served page is built from. Everything
 * else in the capability handles rows; `ExpirySweep` deletes objects only
 * once their rows are gone.
 *
 * The upload contract is object put, then row insert, object rollback on a
 * refused insert. The object goes first so the metadata lock is never held
 * while the store is slow, and so a refused row leaves nothing behind. A row
 * insert that fails for any reason but a refusal keeps its object: the
 * commit may have happened, and a stored object nobody references costs
 * storage where a referenced object that vanished costs the reader the page.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { contentHash, newInternalId, newPatchId } from "@patchy/core";
import { ContentStore } from "@patchy/content-store";
import * as Patches from "./Patches.js";

export interface UploadInput {
  /** The patch to add a version to, or `null` to create one. */
  readonly patchId: string | null;
  readonly accountId: string;
  readonly apiTokenId: string;
  readonly title: string;
  readonly html: string;
  readonly filename: string | null;
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly cliVersion: string | null;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
}

/** What a served page is built from: the patch, the version, and its HTML. */
export interface Served {
  readonly patch: Patches.Patch;
  readonly version: Patches.PatchVersion;
  readonly html: string;
}

export class Content extends Context.Service<
  Content,
  {
    /**
     * Stores the document and records the version, creating the patch when
     * `patchId` is null. The two refusals are the target's: an update to a
     * patch the caller cannot write, a create on an id already taken.
     */
    readonly upload: (
      input: UploadInput
    ) => Effect.Effect<
      Patches.Recorded,
      | Patches.PatchUnavailable
      | Patches.PatchConflict
      | SqlError
      | ContentStore.InvalidObjectKey
      | ContentStore.StoreUnavailable
    >;
    /**
     * A patch in service with its current or numbered version and the HTML
     * behind it; `None` for anything `Patches.find` does not answer. The
     * object missing under a recorded key is a fault, not an absence.
     */
    readonly read: (
      patchId: string,
      versionNumber?: number
    ) => Effect.Effect<
      Option.Option<Served>,
      SqlError | ContentStore.InvalidObjectKey | ContentStore.StoreUnavailable
    >;
  }
>()("@patchy/patches/Content") {}

/** Where a version's bytes go. */
export const objectKey = (patchId: string, versionId: string) =>
  `patches/${patchId}/versions/${versionId}.html`;

export const make = Effect.gen(function* () {
  const patches = yield* Patches.Patches;
  const store = yield* ContentStore.ContentStore;

  /** Deletes the object a refused row left behind, then re-raises the refusal. */
  const rollback = <E>(key: string, refusal: E) =>
    store.delete(key).pipe(Effect.orDie, Effect.andThen(Effect.fail(refusal)));

  const upload = Effect.fn("Content.upload")(function* (input: UploadInput) {
    const patchId = input.patchId ?? newPatchId();
    const versionId = newInternalId("ver");
    const key = objectKey(patchId, versionId);
    const target = {
      intent: input.patchId === null ? "create" : "update",
      patchId,
      accountId: input.accountId
    } satisfies Patches.UploadTarget;

    yield* patches.checkTarget(target);
    yield* store.put(key, input.html);
    return yield* patches
      .record({
        ...target,
        versionId,
        apiTokenId: input.apiTokenId,
        title: input.title,
        objectKey: key,
        contentHash: contentHash(input.html),
        fileSize: new TextEncoder().encode(input.html).length,
        filename: input.filename,
        repoOrg: input.repoOrg,
        repoName: input.repoName,
        cliVersion: input.cliVersion,
        gitBranch: input.gitBranch,
        gitCommitSha: input.gitCommitSha,
        sourceIp: input.sourceIp,
        userAgent: input.userAgent
      })
      .pipe(
        // A refused row is the one case the object must not survive. A rollback
        // that itself fails is a defect: an orphan reported as a clean refusal
        // would be a lie.
        Effect.catchTags({
          PatchUnavailable: (refusal) => rollback(key, refusal),
          PatchConflict: (refusal) => rollback(key, refusal)
        })
      );
  });

  const read = Effect.fn("Content.read")(function* (patchId: string, versionNumber?: number) {
    const found = yield* patches.find(patchId, versionNumber);
    if (Option.isNone(found)) return Option.none();
    const html = yield* store
      .get(found.value.version.objectKey)
      .pipe(Effect.catchTags({ ObjectNotFound: Effect.die }));
    return Option.some({ ...found.value, html } satisfies Served);
  });

  return Content.of({ upload, read });
});

/** Over `Patches` and the content store. */
export const layer = Layer.effect(Content, make);
