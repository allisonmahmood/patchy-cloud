import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { LoadedVersion } from "./LoadedVersions.js";

/** Patch-owned grant and eligibility policy, supplied by Patches at the host boundary. */
export class GuestAccess extends Context.Service<
  GuestAccess,
  {
    readonly admit: (
      loaded: LoadedVersion & { readonly patchTier: number },
      userId: string
    ) => Effect.Effect<boolean, SqlError>;
  }
>()("@patchy/runtime/GuestAccess") {}
