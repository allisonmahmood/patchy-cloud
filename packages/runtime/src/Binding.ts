import * as Context from "effect/Context";
import type { AgentIdentity, RuntimeMe, RuntimePrincipal } from "@patchy/api";
import type { LoadedVersion } from "./LoadedVersions.js";

/** Only admission constructs a binding; handlers acquire it from the environment. */
export class Binding extends Context.Service<
  Binding,
  LoadedVersion & {
    readonly principal: typeof RuntimePrincipal.Type;
    readonly identity: typeof RuntimeMe.Type;
    readonly correlationId: string;
    /** Set only by host admission, never handler arguments. */
    readonly agent?: AgentIdentity;
    /** Invocation callbacks retain the viewer but act as the patch for owned resources. */
    readonly effectivePrincipal?: string;
    readonly invocationId?: string;
  }
>()("@patchy/runtime/Binding") {}
