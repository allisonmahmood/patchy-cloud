import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as WideEvents from "@patchy/analytics/wide-events";

/** Keys identify resources, never their values. Empty keys request durable reconciliation. */
export type Listener = (keys: readonly string[], causedByEventId?: string) => Effect.Effect<void>;

export class Wakes extends Context.Service<
  Wakes,
  {
    readonly publish: (keys: readonly string[], causedByEventId?: string) => Effect.Effect<void>;
    readonly subscribe: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@patchy/runtime/Wakes") {}

export const make = Effect.sync(() => {
  const listeners = new Set<Listener>();
  return Wakes.of({
    publish: (keys, causedByEventId) =>
      Effect.flatMap(WideEvents.currentEventId, (eventId) =>
        Effect.forEach(listeners, (listener) => listener(keys, causedByEventId ?? eventId), {
          discard: true
        })
      ),
    subscribe: (listener) =>
      Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() => listeners.add(listener)),
          () =>
            Effect.sync(() => {
              listeners.delete(listener);
            })
        )
      )
  });
});

/** Local development shares one bus across its writers and connected documents. */
export const layer = Layer.effect(Wakes, make);
