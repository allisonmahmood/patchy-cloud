import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OperatingLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import * as Runtime from "./Runtime.js";

/** The stream only reads limits; local dev has no platform override database. */
export class StreamLimits extends Context.Service<
  StreamLimits,
  {
    readonly getMany: <
      const Limits extends Readonly<Record<string, keyof typeof registry>>
    >(input: {
      readonly companyId: string;
      readonly limits: Limits;
    }) => Effect.Effect<
      { readonly [Key in keyof Limits]: OperatingLimits.EffectiveLimit },
      Runtime.RuntimeError
    >;
  }
>()("@patchy/runtime/StreamLimits") {}

export const make = Effect.gen(function* () {
  const limits = yield* OperatingLimits.OperatingLimits;
  return StreamLimits.of({
    getMany: (input) =>
      limits
        .getMany(input)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })))
  });
});
export const layer = Layer.effect(StreamLimits, make);

export const layerLocal = Layer.succeed(StreamLimits, {
  getMany: (input) =>
    Effect.succeed(
      Object.fromEntries(
        Object.entries(input.limits).map(([name, limitId]) => [
          name,
          {
            companyId: input.companyId,
            limitId,
            value: registry[limitId].default,
            overrideValue: null,
            configRevision: { deploymentRevision: "local", overrideRevision: "0" }
          }
        ])
      ) as { readonly [Key in keyof typeof input.limits]: OperatingLimits.EffectiveLimit }
    )
});
