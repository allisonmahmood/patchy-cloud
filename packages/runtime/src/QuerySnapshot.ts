import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as InvocationCapabilities from "./InvocationCapabilities.js";
import type * as Runtime from "./Runtime.js";

/** Retains and fences query callbacks; declared company resources share one read-only transaction. */
export interface Resource extends InvocationCapabilities.RetainedResource {
  readonly watermark: Readonly<Record<string, string>>;
  readonly dbMs: number;
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | InvocationCapabilities.CapabilityRefused, R>;
}

/** Primitives supplies the database adapter; Runtime owns the invocation lifetime. */
export class QuerySnapshot extends Context.Service<
  QuerySnapshot,
  {
    readonly open: (
      capability: InvocationCapabilities.Capability
    ) => Effect.Effect<Resource, Runtime.RuntimeError | InvocationCapabilities.CapabilityRefused>;
  }
>()("@patchy/runtime/QuerySnapshot") {}
