import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Limits } from "@patchy/limits";
import * as Binding from "./Binding.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";

export const layer = (
  handlers: Readonly<Record<string, Runtime.Handler>>,
  options: {
    readonly origin: string;
    readonly identity: NonNullable<Binding.Binding["Service"]["identity"]>;
  }
): Layer.Layer<
  Runtime.Runtime,
  Config.ConfigError,
  LoadedVersions.LoadedVersions | Limits.Limits
> =>
  Layer.effect(
    Runtime.Runtime,
    Runtime.make(handlers, { origin: options.origin, identity: Effect.succeed(options.identity) })
  );
