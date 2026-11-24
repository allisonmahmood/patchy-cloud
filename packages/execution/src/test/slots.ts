import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * A count of `permits` to give a supervisor as `Supervisor.FetchSlots`, telling the test when a
 * callback asks for its place. Only the callback proxy calls `takeScoped`, once a callback has
 * passed its checks on arrival; invokes take theirs with `withPermit`, unseen. `asked(n)` waits
 * for the nth ask: with every place held, that callback is waiting for one.
 */
export const watchedSlots = Effect.fnUntraced(function* (permits: number) {
  const slots = yield* Semaphore.make(permits);
  const asks: Array<PromiseWithResolvers<void>> = [];
  const ask = (index: number) => (asks[index] ??= Promise.withResolvers<void>());
  let count = 0;
  const watched: Semaphore.Semaphore = {
    resize: (permits) => slots.resize(permits),
    withPermits: (permits) => slots.withPermits(permits),
    withPermit: (self) => slots.withPermit(self),
    withPermitsIfAvailable: (permits) => slots.withPermitsIfAvailable(permits),
    take: (permits) => slots.take(permits),
    takeScoped: (permits) =>
      Effect.suspend(() => {
        ask(count++).resolve();
        return slots.takeScoped(permits);
      }),
    takeIfAvailable: (permits) => slots.takeIfAvailable(permits),
    release: (permits) => slots.release(permits),
    releaseAll: slots.releaseAll
  };
  return {
    slots: watched,
    asked: (n: number) => Effect.promise(() => ask(n - 1).promise).pipe(Effect.timeout(5_000))
  };
});
