import { assert, it } from "@effect/vitest";
import { OrphanSweep } from "@patchy/company-database";
import { DeletionSweep } from "@patchy/patches";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as Server from "./Server.js";

it.effect(
  "retries a defective orphan pass without stopping deletion, and cancels both on shutdown",
  () =>
    Effect.gen(function* () {
      const deletionRuns = yield* Queue.unbounded<number>();
      const orphanRuns = yield* Queue.unbounded<number>();
      const orphanInterrupted = yield* Deferred.make<void>();
      const secret = "postgres://private-user:private-password@database/internal";
      const logs: Array<{ message: unknown; cause: Cause.Cause<unknown> }> = [];
      let deletionPasses = 0;
      let orphanPasses = 0;
      const deletion = Layer.succeed(DeletionSweep.DeletionSweep, {
        sweep: Effect.gen(function* () {
          yield* Queue.offer(deletionRuns, ++deletionPasses);
          return { deleted: 0, skipped: 0, failed: 0, orphanedObjects: 0 };
        })
      });
      const orphan = Layer.succeed(OrphanSweep.OrphanSweep, {
        sweep: Effect.gen(function* () {
          yield* Queue.offer(orphanRuns, ++orphanPasses);
          if (orphanPasses === 1) return yield* Effect.die(new Error(secret));
          // A later hung pass must not delay deletion's next tick either.
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() => Deferred.succeed(orphanInterrupted, undefined))
          );
        })
      });
      const scope = yield* Scope.make();
      yield* Effect.gen(function* () {
        yield* Layer.buildWithScope(
          Server.sweeper.pipe(
            Layer.provide([deletion, orphan]),
            Layer.provide(
              Logger.layer([
                Logger.make((event) => {
                  logs.push({ message: event.message, cause: event.cause });
                })
              ])
            )
          ),
          scope
        );
        assert.strictEqual(yield* Queue.take(deletionRuns), 1);
        assert.strictEqual(yield* Queue.take(orphanRuns), 1);
        yield* TestClock.adjust("1 hour");
        assert.strictEqual(yield* Queue.take(deletionRuns), 2);
        assert.strictEqual(yield* Queue.take(orphanRuns), 2);
        yield* TestClock.adjust("1 hour");
        assert.strictEqual(yield* Queue.take(deletionRuns), 3);
        assert.strictEqual(orphanPasses, 2);
        assert.strictEqual(logs.length, 1);
        assert.notInclude(JSON.stringify(logs), secret);
      }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
      yield* Deferred.await(orphanInterrupted);
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(deletionPasses, 3);
      assert.strictEqual(orphanPasses, 2);
    })
);
