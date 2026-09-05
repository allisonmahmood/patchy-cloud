/**
 * Server-side analytics: the service every business event the instance
 * reports goes through. Two guarantees shape it, both structural:
 *
 * **Readers stay unwatched.** Nothing here ever runs in a reader's browser: a
 * served patch carries no script source of any kind. Serving a patch is
 * deliberately not an event (a visit moves a retention clock in the database
 * and is never reported here), and no event carries a source address, page
 * content, a filename, or a URL. What ships is the shape of what happened:
 * ids, sizes, counts, and states.
 *
 * **A user's request never depends on it.** `track` never fails: a failing
 * backend is a warning in the log and no difference at all to the response.
 *
 * An instance with no key configured gets the no-op layer, which accepts
 * every event and reports none. That is the default: reporting is something
 * an operator switches on, never something an instance starts on its own.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PostHogClient from "./PostHogClient.js";

/**
 * Business-shaped events, named for what happened. `token.minted` is retained
 * for the device-login poll (auth spec §9); it has no emitter until that lands.
 * The list is closed on purpose — serving a patch is not on it.
 */
export type AnalyticsEventName =
  "token.minted" | "patch.created" | "patch.updated" | "patch.deleted" | "patch.expired";

/** What an event property may hold. Ids, sizes, counts, and states — nothing else. */
export type AnalyticsPropertyValue = string | number | boolean | null;

export interface AnalyticsEvent {
  readonly name: AnalyticsEventName;
  /**
   * The principal the event belongs to, or `null` for the events no principal
   * performed — an expiry sweep acts for the instance, not for anyone.
   */
  readonly principalId: string | null;
  readonly properties: Record<string, AnalyticsPropertyValue>;
}

/**
 * Who an event belongs to when no principal performed it. A constant rather
 * than a per-patch or per-address id: the alternative is inventing a person
 * out of a reader, which is exactly what the serving guarantee forbids.
 */
export const INSTANCE_DISTINCT_ID = "patchy-instance";

/** How long the shutdown flush may take before the process stops waiting for it. */
export const SHUTDOWN_FLUSH_TIMEOUT = "3 seconds";

export class Analytics extends Context.Service<
  Analytics,
  {
    /** Reports one event. Never fails: a backend failure is logged and dropped. */
    readonly track: (event: AnalyticsEvent) => Effect.Effect<void>;
  }
>()("@patchy/analytics/Analytics") {}

/**
 * The reporting implementation over a `PostHogClient`. Its finalizer gives
 * whatever is still queued one bounded chance to go out, so a slow analytics
 * backend never holds a shutdown.
 */
export const make = Effect.gen(function* () {
  const client = yield* PostHogClient.PostHogClient;

  yield* Effect.addFinalizer(() =>
    client.shutdown.pipe(
      Effect.timeout(SHUTDOWN_FLUSH_TIMEOUT),
      Effect.catchCause((cause) => Effect.logWarning("Analytics shutdown flush failed.", cause))
    )
  );

  const track = Effect.fn("Analytics.track")((event: AnalyticsEvent) =>
    client
      .capture({
        distinctId: event.principalId ?? INSTANCE_DISTINCT_ID,
        event: event.name,
        properties: {
          ...event.properties,
          // User ids attribute business events without creating person profiles.
          // Reader visits are never analytics events.
          $process_person_profile: false
        }
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Analytics capture failed.", cause).pipe(
            Effect.annotateLogs({ event: event.name })
          )
        )
      )
  );

  return Analytics.of({ track });
});

/** Reports through PostHog; needs a `PostHogClient`. */
export const layerPostHog = Layer.effect(Analytics, make);

/** Accepts every event and reports none — tests, and instances with no key. */
export const layerNoop = Layer.succeed(Analytics, Analytics.of({ track: () => Effect.void }));

/** What an instance runs with: reporting when a key is configured, no-op when it is not. */
export const layer = Layer.unwrap(
  Effect.map(Config.option(PostHogClient.apiKey), (key) =>
    Option.isNone(key) ? layerNoop : layerPostHog.pipe(Layer.provide(PostHogClient.layer))
  )
);
