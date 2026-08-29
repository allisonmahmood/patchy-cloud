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
  name: "draft.created",
  principalId: "acct_1",
  properties: { draftId: "drf_1", versionNumber: 1 }
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

it.effect("reports an event on its principal without a person profile", () =>
  Effect.gen(function* () {
    const client = recording();
    yield* track(event).pipe(
      Effect.provide(Analytics.layerPostHog.pipe(Layer.provide(client.layer)))
    );
    assert.deepStrictEqual(client.messages, [
      {
        distinctId: "acct_1",
        event: "draft.created",
        properties: { draftId: "drf_1", versionNumber: 1, $process_person_profile: false }
      }
    ]);
  })
);

it.effect("reports an event no principal performed under the instance", () =>
  Effect.gen(function* () {
    const client = recording();
    yield* track({ ...event, name: "draft.expired", principalId: null }).pipe(
      Effect.provide(Analytics.layerPostHog.pipe(Layer.provide(client.layer)))
    );
    assert.strictEqual(client.messages[0]?.distinctId, Analytics.INSTANCE_DISTINCT_ID);
  })
);

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
    yield* Layer.buildWithScope(Analytics.layerPostHog.pipe(Layer.provide(hanging)), scope);

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

it.effect("runs the no-op layer when no key is configured", () =>
  Effect.gen(function* () {
    const noop = yield* built(Analytics.layerNoop, {});
    // The no-op layer is a constant, so an unconfigured instance gets that very one.
    assert.strictEqual(yield* built(Analytics.layer, {}), noop);
    assert.notStrictEqual(
      yield* built(Analytics.layer, { PATCHY_POSTHOG_API_KEY: "phc_test" }),
      noop
    );
  })
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
