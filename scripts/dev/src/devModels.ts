/**
 * Where a dev instance's model calls go: the fake provider the supervisor runs on loopback, at
 * `PATCHY_DEV_MODELS_URL`, or nowhere. Without the address every call refuses at once, nothing
 * sent; an address off loopback stops the instance. Production's source is never reachable from
 * here, so no setting can send a dev instance's input or key to a real provider.
 */
import { ModelsSource } from "@patchy/integrations";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const devModels = Layer.unwrap(
  Effect.map(Config.option(Config.String("PATCHY_DEV_MODELS_URL")), (url) =>
    Option.isSome(url) ? ModelsSource.layerAt(url.value) : ModelsSource.refusing
  )
);
