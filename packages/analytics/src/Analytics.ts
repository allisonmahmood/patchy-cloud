/**
 * Server-side business moments. Serving a page is not a business analytics event;
 * visits remain database counts today. Wide events report runtime work, including
 * viewer ids and handler names, through the same PostHog client.
 * Neither event family carries page content, filenames, source addresses or URLs.
 * A reporting failure never fails the caller's request.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PostHogClient from "./PostHogClient.js";

/**
 * Business-shaped events, named for what happened. `token.minted` reports the
 * device-login poll's one-time mint with its user and replacement state.
 * Runtime work is reported separately by WideEvents.
 */
export type AnalyticsEventName =
  "token.minted" | "patch.created" | "patch.updated" | "patch.deleted" | "patch.purged";

/** What an event property may hold. Ids, sizes, counts, and states — nothing else. */
export type AnalyticsPropertyValue = string | number | boolean | null;

export interface AnalyticsEvent {
  readonly name: AnalyticsEventName;
  /**
   * The principal the event belongs to, or `null` for the events no principal
   * performed. A deletion sweep acts for the instance, not for anyone.
   */
  readonly principalId: string | null;
  readonly properties: Record<string, AnalyticsPropertyValue>;
}

/** The principal used for business events no user performed, such as a sweep. */
export const INSTANCE_DISTINCT_ID = "patchy-instance";

export class Analytics extends Context.Service<
  Analytics,
  {
    /** Reports one event. Never fails: a backend failure is logged and dropped. */
    readonly track: (event: AnalyticsEvent) => Effect.Effect<void>;
  }
>()("@patchy/analytics/Analytics") {}

/** The shared PostHog client owns its one bounded shutdown flush. */
export const make = Effect.gen(function* () {
  const client = yield* PostHogClient.PostHogClient;

  const track = Effect.fn("Analytics.track")((event: AnalyticsEvent) =>
    client
      .capture({
        distinctId: event.principalId ?? INSTANCE_DISTINCT_ID,
        event: event.name,
        properties: {
          ...event.properties,
          // User ids attribute business events without creating person profiles.
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

/** Accepts every event and reports none. */
export const layerNoop = Layer.succeed(Analytics, Analytics.of({ track: () => Effect.void }));

/** PostHog reporting is optional; the shared client owns that configuration. */
export const layer = layerPostHog.pipe(Layer.provide(PostHogClient.layer));
