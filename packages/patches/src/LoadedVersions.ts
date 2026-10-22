import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { LoadedVersions } from "@patchy/runtime";
import * as Patches from "./Patches.js";

/**
 * A version in service as Runtime runs it, with its effective audience: what a page's call
 * loads, and what Patchy MCP's door runs an agent's call on.
 */
export const loaded = ({
  patch,
  version,
  patchTier
}: {
  readonly patch: Patches.Patch;
  readonly version: Patches.PatchVersion;
  readonly patchTier: number;
}): LoadedVersions.LoadedVersion & { readonly patchTier: number } => ({
  patchId: patch.id,
  versionId: version.id,
  companyId: patch.companyId,
  manifest: version.manifest,
  wireVersion: version.wireVersion,
  patchTier,
  scope:
    patch.scope === "public" && patch.currentVersionId === version.id
      ? ("public" as const)
      : ("company" as const)
});

/** Shares the serving door's live current/exact-version lookup and effective audience. */
export const make = Effect.gen(function* () {
  const patches = yield* Patches.Patches;
  return LoadedVersions.LoadedVersions.of({
    find: Effect.fn("LoadedVersions.find")(function* (patchId, versionId) {
      return Option.map(yield* patches.find(patchId, undefined, versionId), loaded);
    })
  });
});

export const layer = Layer.effect(LoadedVersions.LoadedVersions, make);
