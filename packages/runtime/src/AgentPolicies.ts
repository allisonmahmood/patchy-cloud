import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { AgentMode, Identity } from "@patchy/api";

/** Patch-owned access supplied by Patches; the runtime never owns policy storage. */
export class AgentPolicies extends Context.Service<
  AgentPolicies,
  {
    readonly read: (
      patchId: string,
      identity: Identity
    ) => Effect.Effect<
      {
        readonly mode: typeof AgentMode.Type;
        readonly handlers: readonly string[];
      } | null,
      SqlError
    >;
  }
>()("@patchy/runtime/AgentPolicies") {}
