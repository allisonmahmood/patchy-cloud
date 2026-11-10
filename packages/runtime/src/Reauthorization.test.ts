import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Reauthorization from "./Reauthorization.js";

it.effect(
  "reuses unchanged authority, refuses changed authority and failed reads, and allows restoration",
  () =>
    Effect.gen(function* () {
      let revision = "1";
      let allowed = true;
      let unavailable = false;
      let checks = 0;
      const authorize = Effect.suspend(() => {
        checks++;
        return allowed ? Effect.succeed("viewer") : Effect.fail("denied" as const);
      });
      const authority = Effect.suspend(() =>
        unavailable ? Effect.fail("unavailable" as const) : Effect.succeed(revision)
      );
      const recheck = yield* Reauthorization.reuse(authorize, authority);
      assert.strictEqual(yield* recheck, "viewer");
      assert.strictEqual(yield* recheck, "viewer");
      assert.strictEqual(checks, 1);
      unavailable = true;
      assert.strictEqual(yield* recheck.pipe(Effect.flip), "unavailable");
      unavailable = false;
      revision = "2";
      allowed = false;
      assert.strictEqual(yield* recheck.pipe(Effect.flip), "denied");
      revision = "3";
      allowed = true;
      assert.strictEqual(yield* recheck, "viewer");
    })
);

it.effect("does not cache an admission when authority changes during its read", () =>
  Effect.gen(function* () {
    let revision = 0;
    let checks = 0;
    const recheck = yield* Reauthorization.reuse(
      Effect.sync(() => {
        checks++;
        revision++;
        return "viewer";
      }),
      Effect.sync(() => String(revision))
    );
    yield* recheck;
    yield* recheck;
    assert.strictEqual(checks, 2);
  })
);
