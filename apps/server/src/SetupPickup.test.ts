import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Analytics } from "@patchy/analytics";
import { SetupLinks } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Limits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { FrontDoor } from "@patchy/sdk";
import * as Testing from "@patchy/sql/testing";
import * as SetupPickup from "./SetupPickup.js";
import { NodeCryptography } from "@patchy/core";

const layer = SetupPickup.layer.pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provide(Limits.layer),
  Layer.provide(
    Layer.succeed(Analytics.Analytics, Analytics.Analytics.of({ track: () => Effect.void }))
  ),
  Layer.provideMerge(NodeCryptography.layer)
);

it.layer(layer)("SetupPickup", (it) => {
  it.effect("answers the plain page once an address spends its minute of pickups", () =>
    Effect.gen(function* () {
      const { pickUp } = yield* FrontDoor.SetupPickup;
      const line = yield* SetupLinks.current(DEV_SEED.userId);
      const busy = Option.some("203.0.113.7");
      const limit = registry["rate.setupPickup.perMinute"].default;
      for (let index = 0; index < limit; index++) assert.isTrue(yield* pickUp(line.value, busy));
      assert.isFalse(yield* pickUp(line.value, busy));
      // Another address still has its own minute.
      assert.isTrue(yield* pickUp(line.value, Option.some("203.0.113.8")));
    })
  );
});
