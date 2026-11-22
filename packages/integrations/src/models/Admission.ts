/**
 * The host's one admission queue for provider requests, which every door's model calls pass:
 * published actions, `patchy dev` and an admin's test call. A call is granted two permits
 * together, one of the process's (`models.outbound.host`) and one of its provider record's
 * (`models.outbound.provider`), and holds both until the provider's answer is read or the call
 * ends. Waiters are served first come first served per provider record, the oldest first across
 * records when a host permit frees, each until its own deadline; past `models.queue.waiting`
 * waiters a call is refused at once. Nothing is sent while a call waits here.
 */
import { DeploymentConfig } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Errors from "./Errors.js";

/** How the queue let a call through: how long it waited, and the queue as it stood. */
export interface Admitted {
  readonly waitedMs: number;
  /** Provider requests running in the process, this one's included. */
  readonly running: number;
  readonly waiting: number;
}

export class Admission extends Context.Service<
  Admission,
  {
    /**
     * Waits for a host permit and `provider`'s together until `until`, epoch milliseconds, and
     * holds them for the scope. Refuses `busy` with the limit that kept it out.
     */
    readonly acquire: (
      provider: string,
      until: number
    ) => Effect.Effect<Admitted, Errors.Busy, Scope.Scope>;
  }
>()("@patchy/integrations/models/Admission") {}

interface Waiter {
  readonly sequence: number;
  readonly provider: string;
  readonly granted: Deferred.Deferred<void>;
  admitted: boolean;
}

export const make = Effect.gen(function* () {
  const deployment = yield* DeploymentConfig.load;
  const hostLimit = deployment.get("models.outbound.host");
  const providerLimit = deployment.get("models.outbound.provider");
  const waitingLimit = deployment.get("models.queue.waiting");
  let running = 0;
  let waiting = 0;
  let sequence = 0;
  const perProvider = new Map<string, number>();
  const queues = new Map<string, Array<Waiter>>();

  const take = (provider: string) => {
    running++;
    perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
  };
  /** Hands freed permits to the oldest waiters whose provider has room. */
  const grant = () => {
    while (running < hostLimit) {
      let next: Waiter | undefined;
      for (const [provider, queue] of queues) {
        const head = queue[0];
        if (
          head !== undefined &&
          (perProvider.get(provider) ?? 0) < providerLimit &&
          (next === undefined || head.sequence < next.sequence)
        )
          next = head;
      }
      if (next === undefined) return;
      const queue = queues.get(next.provider)!;
      queue.shift();
      if (queue.length === 0) queues.delete(next.provider);
      waiting--;
      take(next.provider);
      next.admitted = true;
      Deferred.doneUnsafe(next.granted, Effect.void);
    }
  };
  const give = (provider: string) =>
    Effect.sync(() => {
      running--;
      const left = (perProvider.get(provider) ?? 1) - 1;
      if (left === 0) perProvider.delete(provider);
      else perProvider.set(provider, left);
      grant();
    });
  const leave = (waiter: Waiter) => {
    const queue = queues.get(waiter.provider);
    const at = queue?.indexOf(waiter) ?? -1;
    if (queue === undefined || at < 0) return;
    queue.splice(at, 1);
    if (queue.length === 0) queues.delete(waiter.provider);
    waiting--;
  };
  /** The limit that keeps `provider` out now, for a refusal. */
  const full = (provider: string, waitedMs: number) =>
    running >= hostLimit
      ? new Errors.Busy({ limitId: "models.outbound.host", value: hostLimit, waitedMs })
      : new Errors.Busy({ limitId: "models.outbound.provider", value: providerLimit, waitedMs });

  const admit = Effect.fnUntraced(function* (provider: string, until: number) {
    const started = yield* Clock.currentTimeMillis;
    if (
      !queues.has(provider) &&
      running < hostLimit &&
      (perProvider.get(provider) ?? 0) < providerLimit
    ) {
      take(provider);
      return { waitedMs: 0, running, waiting } satisfies Admitted;
    }
    if (waiting >= waitingLimit)
      return yield* new Errors.Busy({
        limitId: "models.queue.waiting",
        value: waitingLimit,
        waitedMs: 0
      });
    if (until <= started) return yield* full(provider, 0);
    const waiter: Waiter = {
      sequence: sequence++,
      provider,
      granted: Deferred.makeUnsafe<void>(),
      admitted: false
    };
    const queue = queues.get(provider) ?? [];
    queue.push(waiter);
    queues.set(provider, queue);
    waiting++;
    return yield* Effect.uninterruptibleMask((restore) =>
      restore(Deferred.await(waiter.granted).pipe(Effect.timeoutOption(until - started))).pipe(
        Effect.onInterrupt(() =>
          // A grant that raced the interruption is handed back, not kept.
          waiter.admitted ? give(provider) : Effect.sync(() => leave(waiter))
        ),
        Effect.flatMap((outcome) =>
          Effect.gen(function* () {
            const waitedMs = (yield* Clock.currentTimeMillis) - started;
            if (Option.isNone(outcome) && !waiter.admitted) {
              leave(waiter);
              return yield* full(provider, Math.round(waitedMs));
            }
            return { waitedMs: Math.round(waitedMs), running, waiting } satisfies Admitted;
          })
        )
      )
    );
  });

  return Admission.of({
    // The wait stays interruptible, so an action that ends stops waiting; `admit` itself hands
    // back a grant that raced its interruption.
    acquire: (provider, until) =>
      Effect.acquireRelease(admit(provider, until), () => give(provider), { interruptible: true })
  });
});

export const layer = Layer.effect(Admission, make);
