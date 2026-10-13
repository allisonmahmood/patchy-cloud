import * as Context from "effect/Context";
import type { RuntimeMe, RuntimePrincipal } from "@patchy/api";
import type { LoadedVersion } from "./LoadedVersions.js";

/** Only admission constructs a binding; handlers acquire it from the environment. */
export class Binding extends Context.Service<
  Binding,
  LoadedVersion & {
    readonly principal: typeof RuntimePrincipal.Type;
    readonly identity: typeof RuntimeMe.Type;
    readonly correlationId: string;
    /** Invocation callbacks retain the viewer but act as the patch for owned resources. */
    readonly effectivePrincipal?: string;
    readonly invocationId?: string;
    /**
     * When the caller's deadline for this operation fires, in epoch milliseconds. An integration
     * that queues for a slot stops waiting before it, so a refused wait is never a timeout.
     */
    readonly deadline?: number;
  }
>()("@patchy/runtime/Binding") {}
