import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/** Patches supplies its access decision for connection usage and log metadata. */
export class PatchVisibility extends Context.Service<
  PatchVisibility,
  {
    readonly visibleIds: (
      companyId: string,
      userId: string,
      patchIds: readonly string[]
    ) => Effect.Effect<ReadonlySet<string>, SqlError>;
  }
>()("@patchy/integrations/PatchVisibility") {}
