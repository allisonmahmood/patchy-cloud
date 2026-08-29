/**
 * The seam between the Fastify app and the ported capability packages. The
 * server builds one `ManagedRuntime` over the layer stack in `start.ts`;
 * these two adapters are the only places the app runs an Effect. Deleted by
 * the PR that moves the app itself onto HttpApi.
 */
import { Analytics } from "@patchy/analytics";
import { Limits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";

/** What the app runs on: analytics (PostHog when a key is configured) and the in-memory limiter. */
export const layer = Layer.merge(Analytics.layer, Limits.layer);

export type ServerRuntime = ManagedRuntime.ManagedRuntime<
  Analytics.Analytics | Limits.Limits,
  never
>;

/** Spends one attempt of a rate limit; see `Limits.consume`. */
export function consume(
  runtime: ServerRuntime,
  options: Limits.ConsumeOptions
): Promise<Limits.ConsumeResult> {
  return runtime.runPromise(Effect.flatMap(Limits.Limits, (limits) => limits.consume(options)));
}

/**
 * Reports one event. Fire-and-forget: it never throws, never returns a
 * promise, and must never be awaited. Callers hand it what happened and
 * carry on answering the request.
 */
export function track(runtime: ServerRuntime, event: Analytics.AnalyticsEvent): void {
  runtime.runFork(Effect.flatMap(Analytics.Analytics, (analytics) => analytics.track(event)));
}
