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

/** Whether the ticket holds both permits now; a grant changes it while its call waits. */
const holds = (ticket: Ticket) => ticket.state === "held";

/** One call's place: queued, holding both permits, or settled. */
interface Ticket {
  readonly provider: string;
  readonly sequence: number;
  state: "new" | "waiting" | "held" | "done";
  granted?: Deferred.Deferred<void>;
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
  const queues = new Map<string, Array<Ticket>>();

  const take = (ticket: Ticket) => {
    running++;
    perProvider.set(ticket.provider, (perProvider.get(ticket.provider) ?? 0) + 1);
    ticket.state = "held";
  };
  const dequeue = (ticket: Ticket) => {
    const queue = queues.get(ticket.provider);
    const at = queue?.indexOf(ticket) ?? -1;
    if (queue === undefined || at < 0) return;
    queue.splice(at, 1);
    if (queue.length === 0) queues.delete(ticket.provider);
    waiting--;
  };
  /** Hands freed permits to the oldest waiters whose provider has room. */
  const grant = () => {
    while (running < hostLimit) {
      let next: Ticket | undefined;
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
      dequeue(next);
      take(next);
      Deferred.doneUnsafe(next.granted!, Effect.void);
    }
  };
  /** Gives back whatever the ticket holds, once: its place in the queue or both permits. */
  const settle = (ticket: Ticket) => {
    if (ticket.state === "waiting") dequeue(ticket);
    else if (ticket.state === "held") {
      running--;
      const left = (perProvider.get(ticket.provider) ?? 1) - 1;
      if (left === 0) perProvider.delete(ticket.provider);
      else perProvider.set(ticket.provider, left);
      ticket.state = "done";
      grant();
    }
    ticket.state = "done";
  };
  /** The limit that keeps `provider` out now, for a refusal. */
  const full = (provider: string, waitedMs: number) =>
    running >= hostLimit
      ? new Errors.Busy({ limitId: "models.outbound.host", value: hostLimit, waitedMs })
      : new Errors.Busy({ limitId: "models.outbound.provider", value: providerLimit, waitedMs });

  const acquire = Effect.fnUntraced(function* (provider: string, until: number) {
    const ticket: Ticket = { provider, sequence: sequence++, state: "new" };
    // Before anything is queued or taken, so however the call ends, even interrupted the
    // moment a permit is handed to it, what it holds then goes back exactly once.
    yield* Effect.addFinalizer(() => Effect.sync(() => settle(ticket)));
    const started = yield* Clock.currentTimeMillis;
    if (
      !queues.has(provider) &&
      running < hostLimit &&
      (perProvider.get(provider) ?? 0) < providerLimit
    ) {
      take(ticket);
      return { waitedMs: 0, running, waiting } satisfies Admitted;
    }
    if (waiting >= waitingLimit)
      return yield* new Errors.Busy({
        limitId: "models.queue.waiting",
        value: waitingLimit,
        waitedMs: 0
      });
    if (until <= started) return yield* full(provider, 0);
    ticket.granted = Deferred.makeUnsafe<void>();
    ticket.state = "waiting";
    const queue = queues.get(provider) ?? [];
    queue.push(ticket);
    queues.set(provider, queue);
    waiting++;
    // Interruptible: an action that ends stops waiting, and the finalizer settles its ticket.
    yield* Deferred.await(ticket.granted).pipe(Effect.timeoutOption(until - started));
    const waitedMs = Math.round((yield* Clock.currentTimeMillis) - started);
    if (!holds(ticket)) {
      settle(ticket);
      return yield* full(provider, waitedMs);
    }
    return { waitedMs, running, waiting } satisfies Admitted;
  });

  return Admission.of({ acquire });
});

export const layer = Layer.effect(Admission, make);
