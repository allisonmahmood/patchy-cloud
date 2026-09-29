import type { GuestProtocol } from "@patchy/api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { LoadedVersion } from "./LoadedVersions.js";
import type { RuntimeError } from "./Runtime.js";

/** The host supplies retained bytes only after loaded-version admission. */
export class ServerBundles extends Context.Service<
  ServerBundles,
  {
    readonly load: (version: LoadedVersion) => Effect.Effect<GuestProtocol.Bundle, RuntimeError>;
  }
>()("@patchy/runtime/ServerBundles") {}
