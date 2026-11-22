// @effect-diagnostics globalFetch:off -- the test watches the process's own fetch, which a source would use.
import { assert, it } from "@effect/vitest";
import { ModelsSource } from "@patchy/integrations";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { devModels } from "./devModels.js";

/** Every fetch the process makes while `effect` runs, none of them sent. */
const watchingFetch = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = globalThis.fetch;
      const seen: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        seen.push(String(input instanceof Request ? input.url : input));
        throw new Error("no request may leave");
      }) as typeof fetch;
      return { original, seen };
    }),
    ({ seen }) => Effect.map(effect, (value) => ({ value, seen })),
    ({ original }) =>
      Effect.sync(() => {
        globalThis.fetch = original;
      })
  );

const call = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const source = yield* ModelsSource.Source;
    const dispatch = {
      deadline: (yield* Clock.currentTimeMillis) + 30_000,
      attempt: { sent: false },
      beforeSend: Effect.succeed(Redacted.make("sk-stored-key"))
    };
    const generated = yield* Effect.exit(
      source.generate({ model: "gpt-5-mini" }, { input: "hello", maxOutputTokens: 16 }, dispatch)
    );
    const decided = yield* Effect.exit(
      source.decide(
        { model: "gpt-6-luna" },
        { input: "hello", questions: { spam: { type: "yesNo", instructions: "It is spam." } } },
        dispatch
      )
    );
    return { generated, decided, sent: dispatch.attempt.sent };
  }).pipe(
    Effect.provide(
      devModels.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
    )
  );

it.effect("without the fake's address, a dev instance's model calls go nowhere", () =>
  Effect.gen(function* () {
    const { value, seen } = yield* watchingFetch(call({}));
    assert.deepStrictEqual(seen, []);
    assert.isFalse(value.sent);
    const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [value.generated, value.decided];
    for (const exit of exits) {
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.include(String(exit.cause), "ModelsUnavailable");
    }
  })
);

it.effect("with an address off loopback, a dev instance doesn't start its model calls", () =>
  Effect.gen(function* () {
    const { value, seen } = yield* watchingFetch(
      Effect.exit(call({ PATCHY_DEV_MODELS_URL: "https://api.openai.com/v1" }))
    );
    assert.deepStrictEqual(seen, []);
    assert.isTrue(Exit.isFailure(value));
  })
);

it.effect("with the fake's loopback address, a dev instance calls only that", () =>
  Effect.gen(function* () {
    const { seen } = yield* watchingFetch(call({ PATCHY_DEV_MODELS_URL: "http://127.0.0.1:9/v1" }));
    assert.isTrue(seen.length > 0);
    assert.isTrue(seen.every((url) => url.startsWith("http://127.0.0.1:9/v1/")));
  })
);
