import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { LoadedVersions } from "@patchy/runtime";
import * as Patches from "./Patches.js";

/** Shares the serving door's live current/exact-version lookup and effective audience. */
export const make = Effect.gen(function* () {
  const patches = yield* Patches.Patches;
  return LoadedVersions.LoadedVersions.of({
    find: Effect.fn("LoadedVersions.find")(function* (patchId, versionId) {
      const retained = yield* patches.findRetained(patchId, undefined, versionId);
      const found = Option.filter(
        retained,
        ({ patch }) => patch.state === "live" && patch.disabledAt === null
      );
      return Option.map(found, ({ patch, version }) => ({
        patchId: patch.id,
        versionId: version.id,
        companyId: patch.companyId,
        manifest: version.manifest,
        wireVersion: version.wireVersion,
        revoked: version.revokedAt !== null,
        scope:
          patch.scope === "public" && patch.currentVersionId === version.id
            ? ("public" as const)
            : ("company" as const)
      }));
    })
  });
});

export const layer = Layer.effect(LoadedVersions.LoadedVersions, make);
