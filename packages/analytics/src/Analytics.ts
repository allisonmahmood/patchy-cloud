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

/** What an event property may hold. Ids, sizes, counts, and states — nothing else. */
export type AnalyticsPropertyValue = string | number | boolean | null | ReadonlyArray<string>;

/**
 * Holds every catalogue entry to property values an event may carry. Entries are
 * type aliases, not interfaces: an interface has no index signature to check.
 */
type Catalogue<T extends { readonly [Name in keyof T]: Record<string, AnalyticsPropertyValue> }> =
  T;

/** The patch an event is about and who owned it at that moment. */
type PatchSubject = {
  readonly patchId: string;
  readonly ownerUserId: string;
};

/** What a publish reports about the version it recorded. */
type Publication = PatchSubject & {
  readonly machineTokenId: string;
  readonly versionNumber: number;
  readonly scope: string;
  readonly tier: number;
  readonly htmlBytes: number;
  readonly serverBytes: number;
  readonly sdkImports: ReadonlyArray<string>;
  readonly tables: ReadonlyArray<string>;
  readonly stores: ReadonlyArray<string>;
  /** `kind:alias`, one per declared integration. */
  readonly integrations: ReadonlyArray<string>;
  readonly queryHandlers: number;
  readonly mutationHandlers: number;
  readonly actionHandlers: number;
};

/**
 * Every business event, named for what happened, with the properties it carries
 * beyond `companyId`. Each entry says when it fires and who its principal is.
 * Runtime work is reported separately by WideEvents.
 */
export type AnalyticsCatalogue = Catalogue<{
  /** A device login's poll minted a machine token. Principal: the user who signed in. */
  readonly "token.minted": {
    readonly tokenId: string;
    /** The login replaced one of the user's earlier machine tokens. */
    readonly replaced: boolean;
  };

  /** A publish created a patch and its first version. Principal: the publisher. */
  readonly "patch.created": Publication;

  /** A publish added a version to an existing patch. Principal: the publisher. */
  readonly "patch.updated": Publication;

  /** A patch entered its recovery window. Principal: the user who deleted it. */
  readonly "patch.deleted": PatchSubject;

  /** The deletion sweep removed a patch whose recovery window ended. Principal: the instance. */
  readonly "patch.purged": PatchSubject & {
    readonly versionsRemoved: number;
  };
}>;

export type AnalyticsEventName = keyof AnalyticsCatalogue;

/** One business event; its `name` decides the properties it carries. */
export type AnalyticsEvent = {
  readonly [Name in AnalyticsEventName]: {
    readonly name: Name;
    /**
     * The principal the event belongs to, or `null` for the events no principal
     * performed. A deletion sweep acts for the instance, not for anyone.
     */
    readonly principalId: string | null;
    /** The company the moment happened in. Every business moment has one. */
    readonly companyId: string;
    readonly properties: AnalyticsCatalogue[Name];
  };
}[AnalyticsEventName];

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
          companyId: event.companyId,
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
