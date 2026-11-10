import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Invocation-local reuse. Failed reads never fall back to an earlier authorization. */
export const reuse = Effect.fnUntraced(function* <A, E>(
  authorize: Effect.Effect<A, E>,
  authority: Effect.Effect<string, E>
) {
  const lock = yield* Semaphore.make(1);
  let cached: { readonly revision: string; readonly value: A } | undefined;
  return lock.withPermit(
    Effect.gen(function* () {
      const before = yield* authority;
      if (cached?.revision === before) return cached.value;
      cached = undefined;
      const value = yield* authorize;
      const after = yield* authority;
      if (before === after) cached = { revision: after, value };
      return value;
    })
  );
});
