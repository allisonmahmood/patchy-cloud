import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { INSTANCE_DISTINCT_ID } from "./Analytics.js";
import * as PostHogClient from "./PostHogClient.js";
import * as WideEvents from "./WideEvents.js";

/** Each sink is attempted even if the other fails; the event owner bounds delivery. */
export const make = Effect.gen(function* () {
  const client = yield* PostHogClient.PostHogClient;
  const stdout = yield* Console.Console;
  return WideEvents.Sink.of({
    write: (event) =>
      Effect.all(
        [
          Effect.sync(() => stdout.log(WideEvents.formatJson(event))).pipe(
            Effect.catchCause(() => Effect.void)
          ),
          Effect.suspend(() =>
            client.capture({
              distinctId:
                ("viewerId" in event ? event.viewerId : undefined) ??
                event.companyId ??
                INSTANCE_DISTINCT_ID,
              event: `wide.${event.type}`,
              properties: { ...event, $process_person_profile: false }
            })
          ).pipe(Effect.catchCause(() => Effect.void))
        ],
        { concurrency: "unbounded", discard: true }
      )
  });
});

export const layerSink = Layer.effect(WideEvents.Sink, make);

/** Stdout always emits. PostHog is optional and shares Analytics' client and shutdown. */
export const layer = WideEvents.layerWithSink.pipe(
  Layer.provide(layerSink.pipe(Layer.provide(PostHogClient.layer))),
  Layer.provide(WideEvents.layerMetadata)
);
