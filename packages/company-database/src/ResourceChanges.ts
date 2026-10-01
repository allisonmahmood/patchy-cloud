import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The transaction owner announces committed resource keys; the host supplies delivery. */
export class ResourceChanges extends Context.Service<
  ResourceChanges,
  { readonly publish: (keys: readonly string[]) => Effect.Effect<void> }
>()("@patchy/company-database/ResourceChanges") {}
