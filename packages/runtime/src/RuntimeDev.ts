import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Limits } from "@patchy/limits";
import * as Binding from "./Binding.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import { Cryptography } from "@patchy/core";

export const layer = (
  handlers: Readonly<Record<string, Runtime.Handler>>,
  options: {
    readonly origin: string;
    readonly identity: NonNullable<Binding.Binding["Service"]["identity"]>;
  }
): Layer.Layer<
  Runtime.Runtime,
  never,
  LoadedVersions.LoadedVersions | Limits.Limits | Cryptography.Cryptography
> => {
  const identity = Effect.succeed({
    viewer: options.identity,
    reauthorize: Effect.succeed(options.identity)
  });
  return Layer.effect(
    Runtime.Runtime,
    Runtime.make(handlers, {
      origin: options.origin,
      identity
    })
  );
};
