import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Manifest, SharingScope } from "@patchy/api";

export interface LoadedVersion {
  readonly patchId: string;
  readonly versionId: string;
  readonly companyId: string;
  readonly manifest: typeof Manifest.Type;
  /** Effective audience: historical versions of public patches remain company-only. */
  readonly scope: typeof SharingScope.Type;
  readonly wireVersion: number;
}

/** Patches supplies this port; Runtime never imports the patch repository. */
export class LoadedVersions extends Context.Service<
  LoadedVersions,
  {
    /** Omit versionId for the live current source; exact-version admission is unchanged. */
    readonly find: (
      patchId: string,
      versionId?: string
    ) => Effect.Effect<Option.Option<LoadedVersion>, SqlError>;
  }
>()("@patchy/runtime/LoadedVersions") {}
