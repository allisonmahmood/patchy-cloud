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
  }
>()("@patchy/runtime/Binding") {}
