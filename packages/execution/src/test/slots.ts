import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * A count of `permits` to give a supervisor as `Supervisor.FetchSlots`, telling the test when a
 * callback or an invoke asks for its place. Only the callback proxy calls `takeScoped`, once a
 * callback has passed its checks on arrival, and only an invoke's dispatch calls `withPermit`.
 * `asked(n)` waits for the nth callback's ask and `invoked(n)` for the nth invoke's: with every
 * place held, that one is waiting for one.
 */
export const watchedSlots = Effect.fnUntraced(function* (permits: number) {
  const slots = yield* Semaphore.make(permits);
  const signals = () => {
    const asks: Array<PromiseWithResolvers<void>> = [];
    const ask = (index: number) => (asks[index] ??= Promise.withResolvers<void>());
    let count = 0;
    return {
      mark: () => ask(count++).resolve(),
      nth: (n: number) => Effect.promise(() => ask(n - 1).promise).pipe(Effect.timeout(5_000))
    };
  };
  const callbacks = signals();
  const invokes = signals();
  const watched: Semaphore.Semaphore = {
    resize: (permits) => slots.resize(permits),
    withPermits: (permits) => slots.withPermits(permits),
    withPermit: (self) =>
      Effect.suspend(() => {
        invokes.mark();
        return slots.withPermit(self);
      }),
    withPermitsIfAvailable: (permits) => slots.withPermitsIfAvailable(permits),
    take: (permits) => slots.take(permits),
    takeScoped: (permits) =>
      Effect.suspend(() => {
        callbacks.mark();
        return slots.takeScoped(permits);
      }),
    takeIfAvailable: (permits) => slots.takeIfAvailable(permits),
    release: (permits) => slots.release(permits),
    releaseAll: slots.releaseAll
  };
  return { slots: watched, asked: callbacks.nth, invoked: invokes.nth };
});
