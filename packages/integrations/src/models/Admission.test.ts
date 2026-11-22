import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Admission from "./Admission.js";

/**
 * The host's admission queue under cancellation: a waiter interrupted as a permit is handed to it
 * gives the permit back, so the queue's full capacity returns.
 */

// One permit and one waiting place, so a probe that can't wait says whether a waiter is queued.
const one = Admission.layer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_LIMITS_JSON: JSON.stringify({
          "models.outbound.provider": 1,
          "models.queue.waiting": 1
        })
      })
    )
  )
);

// The queue reads the clock its deadlines are given in, so these tests run on the real one.
it.layer(one, { excludeTestServices: true })("admission", (it) => {
  it.effect("gets every permit back when a queued waiter is interrupted as one is handed to it", () =>
    Effect.gen(function* () {
      const admission = yield* Admission.Admission;
      /** What a call that can't wait is told now: which limit keeps it out, or that it got in. */
      const probe = Effect.scoped(admission.acquire("provider", Date.now())).pipe(
        Effect.match({ onFailure: (busy) => busy.limitId, onSuccess: () => "free" as const })
      );
      for (let round = 0; round < 120; round++) {
        const holder = yield* Scope.make();
        // A permit lost in an earlier round leaves this refused busy after a moment's wait.
        yield* admission.acquire("provider", Date.now() + 200).pipe(Scope.provide(holder));
        // The waiter yields after every operation, so the interruption can land at any step of
        // its wake-up, the steps after the grant included.
        const waiter = yield* Effect.forkChild(
          Effect.scoped(
            Effect.andThen(admission.acquire("provider", Date.now() + 60_000), Effect.never)
          ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1))
        );
        // Until the waiter is queued behind the holder: the queue's one waiting place is taken.
        while ((yield* probe) !== "models.queue.waiting") yield* Effect.yieldNow;
        // The holder's release hands its permit to the queued waiter, which is interrupted at
        // once or some steps later, before or after it resumes.
        yield* Scope.close(holder, Exit.void);
        for (let step = 0; step < round % 30; step++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiter);
        // The one permit is free again, with nothing running or waiting.
        const free = yield* Effect.scoped(admission.acquire("provider", Date.now()));
        assert.deepStrictEqual(free, { waitedMs: 0, running: 1, waiting: 0 }, `round ${round}`);
      }
    })
  );
});
