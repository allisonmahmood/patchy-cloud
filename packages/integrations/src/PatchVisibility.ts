import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/**
 * Patches supplies its access decision for connection usage and recent calls: the company's
 * patches this person can open now. Connection pages name only those and show only their calls,
 * so a patch the person can't open, or one since reclaimed, stays out.
 */
export class PatchVisibility extends Context.Service<
  PatchVisibility,
  {
    readonly openableIds: (
      companyId: string,
      userId: string
    ) => Effect.Effect<ReadonlyArray<string>, SqlError>;
  }
>()("@patchy/integrations/PatchVisibility") {}
