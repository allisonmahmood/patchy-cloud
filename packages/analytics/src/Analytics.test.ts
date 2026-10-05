import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as Analytics from "./Analytics.js";
import * as PostHogClient from "./PostHogClient.js";

const event: Analytics.AnalyticsEvent = {
  name: "patch.deleted",
  principalId: "usr_1",
  companyId: "cmp_1",
  properties: { patchId: "pch_1", ownerUserId: "usr_1" }
};

/** A client that keeps every message and answers shutdown at once. */
const recording = () => {
  const messages: PostHogClient.CaptureMessage[] = [];
  const layer = Layer.succeed(
    PostHogClient.PostHogClient,
    PostHogClient.PostHogClient.of({
      capture: (message) => Effect.sync(() => void messages.push(message)),
      shutdown: Effect.void
    })
  );
  return { messages, layer };
};

/** A client whose backend is down: every call fails. */
const broken = Layer.succeed(
  PostHogClient.PostHogClient,
  PostHogClient.PostHogClient.of({
    capture: () => failure("capture"),
    shutdown: failure("shutdown")
  })
);

/** A client whose shutdown flush never comes back. */
const hanging = Layer.succeed(
  PostHogClient.PostHogClient,
  PostHogClient.PostHogClient.of({ capture: () => Effect.void, shutdown: Effect.never })
);

function failure(operation: "capture" | "shutdown") {
  return new PostHogClient.PostHogError({ operation, cause: new Error("Forced failure.") });
}

const track = (event: Analytics.AnalyticsEvent) =>
  Effect.flatMap(Analytics.Analytics, (analytics) => analytics.track(event));

it.effect("reports an event on its principal and company without a person profile", () =>
  Effect.gen(function* () {
    const client = recording();
    yield* track(event).pipe(
      Effect.provide(Analytics.layerPostHog.pipe(Layer.provide(client.layer)))
    );
    assert.deepStrictEqual(client.messages, [
      {
        distinctId: "usr_1",
        event: "patch.deleted",
        properties: {
          patchId: "pch_1",
          ownerUserId: "usr_1",
          companyId: "cmp_1",
          $process_person_profile: false
        }
      }
    ]);
  })
);

it.effect("reports an event no principal performed under the instance", () =>
  Effect.gen(function* () {
    const client = recording();
    yield* track({
      name: "patch.purged",
      principalId: null,
      companyId: "cmp_1",
      properties: { patchId: "pch_1", ownerUserId: "usr_1", versionsRemoved: 1 }
    }).pipe(Effect.provide(Analytics.layerPostHog.pipe(Layer.provide(client.layer))));
    assert.strictEqual(client.messages[0]?.distinctId, Analytics.INSTANCE_DISTINCT_ID);
  })
);

// Typechecking runs this test; its body does nothing at runtime.
it("holds each event to its own catalogue entry", () => {
  void ([
    // @ts-expect-error Every business event names its company.
    { name: "patch.deleted", principalId: "usr_1", properties: event.properties },
    {
      name: "patch.deleted",
      principalId: "usr_1",
      companyId: "cmp_1",
      // @ts-expect-error A patch event names its owner.
      properties: { patchId: "pch_1" }
    },
    {
      name: "token.minted",
      principalId: "usr_1",
      companyId: "cmp_1",
      // @ts-expect-error Properties belong to the event that declares them.
      properties: { tokenId: "mtk_1", replaced: false, patchId: "pch_1" }
    }
  ] satisfies ReadonlyArray<Analytics.AnalyticsEvent>);
});

it.effect("keeps a failing backend away from the caller", () =>
  Effect.gen(function* () {
    const exit = yield* track(event).pipe(
      Effect.provide(Analytics.layerPostHog.pipe(Layer.provide(broken))),
      Effect.exit
    );
    assert.isTrue(Exit.isSuccess(exit));
  })
);

it.effect("gives the shutdown flush three seconds and no more", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(PostHogClient.layerShutdown.pipe(Layer.provide(hanging)), scope);

    let closed = false;
    const closing = yield* Effect.forkChild(
      Scope.close(scope, Exit.void).pipe(Effect.tap(() => Effect.sync(() => void (closed = true))))
    );

    yield* TestClock.adjust("2999 millis");
    assert.isFalse(closed);
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(closing);
    assert.isTrue(closed);
  })
);

const built = (
  layer: Layer.Layer<Analytics.Analytics, Config.ConfigError>,
  env: Record<string, string>
) =>
  Layer.build(layer).pipe(
    Effect.map((context) => Context.get(context, Analytics.Analytics)),
    Effect.scoped,
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
  );

it.effect("refuses a host that is not an http(s) URL", () =>
  Effect.gen(function* () {
    const error = yield* built(Analytics.layer, {
      PATCHY_POSTHOG_API_KEY: "phc_test",
      PATCHY_POSTHOG_HOST: "us.i.posthog.com"
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ConfigError");
  })
);
