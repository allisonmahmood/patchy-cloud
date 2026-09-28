import { ResourceChanges } from "@patchy/company-database";
import { Wakes } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const layer = Layer.effect(
  ResourceChanges.ResourceChanges,
  Effect.map(Wakes.Wakes, (wakes) => ResourceChanges.ResourceChanges.of({ publish: wakes.publish }))
).pipe(Layer.provideMerge(Wakes.layer));
