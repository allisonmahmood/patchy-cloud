import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import type { Manifest, SharingScope } from "@patchy/api";

export interface LoadedVersion {
  readonly patchId: string;
  readonly versionId: string;
  /** Dev keeps the document version stable while each server binding has its own execution id. */
  readonly executionVersionId?: string;
  readonly companyId: string;
  readonly manifest: typeof Manifest.Type;
  /** Effective audience: historical versions of public patches remain company-only. */
  readonly scope: typeof SharingScope.Type;
  /** Set when it was the patch's current version in the read that loaded it. */
  readonly current?: true;
  readonly wireVersion: number;
}

/** Patches supplies this port; Runtime never imports the patch repository. */
export class LoadedVersions extends Context.Service<
  LoadedVersions,
  {
    /**
     * Loads the served tier; omit versionId for the current source. Shared reads supply the
     * initiating viewer so Patches applies its current content decision before returning it.
     */
    readonly find: (
      patchId: string,
      versionId?: string,
      viewer?: { readonly companyId: string; readonly userId: string }
    ) => Effect.Effect<Option.Option<LoadedVersion & { readonly patchTier: number }>, SqlError>;
  }
>()("@patchy/runtime/LoadedVersions") {}
