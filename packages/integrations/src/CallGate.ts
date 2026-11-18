/**
 * A fair gate in front of an integration's outbound calls, kept per connection in this replica's
 * memory. At most `concurrent` calls run per connection, and `perPerson` per person on it. A call
 * past either waits its turn, and people take turns: a freed place goes to the next person in
 * rotation who has room, so one person's burst queues behind itself, not in front of everyone.
 * At most `waiting` calls wait per connection and `perPersonWaiting` per person; past those a
 * call is refused at once. A waiter gives up at its cut-off, and nothing it carried was sent.
 *
 * PROTOTYPE: shaped for any integration, used only by model calls. The four existing gates
 * (Pidgeon, Attio, IMAP, PostHog) keep their own.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface Limits {
  readonly concurrent: number;
  readonly perPerson: number;
  readonly waiting: number;
  readonly perPersonWaiting: number;
}

/** Why a call was refused, and how long it waited first. Each integration words its own. */
export class Refused extends Schema.TaggedError<Refused>()("CallGateRefused", {
  /**
   * `waiting` or `personWaiting`: refused at once, the waiting room full. `concurrent` or
   * `perPerson`: waited until the cut-off with that limit still full.
   */
  limit: Schema.Literals(["concurrent", "perPerson", "waiting", "personWaiting"]),
  value: Schema.Int,
  waitedMs: Schema.Number
}) {
  override get message() {
    return `The call gate refused at ${this.limit} (${this.value}) after ${this.waitedMs} ms.`;
  }
}

/** How the call got through: its wait, and the connection's calls running and waiting then. */
export interface Admitted {
  readonly waitedMs: number;
  readonly running: number;
  readonly waiting: number;
}

export interface Key {
  readonly connection: string;
  readonly person: string;
}

interface Waiter {
  readonly deferred: Deferred.Deferred<void>;
  granted: boolean;
}
interface Lane {
  running: number;
  readonly queue: Array<Waiter>;
}
interface Line {
  running: number;
  waiting: number;
  readonly lanes: Map<string, Lane>;
  /** People with calls waiting, in the order they get their next turn. */
  readonly turns: Array<string>;
}

export const make = (limits: Limits) => {
  const lines = new Map<string, Line>();

  const tidy = (key: Key, line: Line, lane: Lane) => {
    if (lane.running === 0 && lane.queue.length === 0) line.lanes.delete(key.person);
    if (line.lanes.size === 0) lines.delete(key.connection);
  };
  /**
   * Lets waiters through while the connection has room, the next person in turn first. Waking a
   * waiter can run it at once, so every count and turn is settled before anyone is woken.
   */
  const dispatch = (line: Line) => {
    const woken: Array<Waiter> = [];
    let index = 0;
    while (line.running < limits.concurrent && index < line.turns.length) {
      const person = line.turns[index]!;
      const lane = line.lanes.get(person);
      if (lane === undefined || lane.queue.length === 0) {
        line.turns.splice(index, 1);
        continue;
      }
      if (lane.running >= limits.perPerson) {
        index++;
        continue;
      }
      const next = lane.queue.shift()!;
      line.waiting--;
      line.running++;
      lane.running++;
      next.granted = true;
      woken.push(next);
      // This person had their turn: to the back, if they have more waiting.
      line.turns.splice(index, 1);
      if (lane.queue.length > 0) line.turns.push(person);
    }
    for (const waiter of woken) Deferred.doneUnsafe(waiter.deferred, Effect.void);
  };
  const leave = (key: Key, line: Line, lane: Lane) => {
    line.running--;
    lane.running--;
    dispatch(line);
    tidy(key, line, lane);
  };
  /** Takes a waiter out of line, unless it was let through meanwhile: then it gives its place up. */
  const abandon = (key: Key, line: Line, lane: Lane, waiter: Waiter) => {
    if (waiter.granted) return leave(key, line, lane);
    const index = lane.queue.indexOf(waiter);
    if (index !== -1) {
      lane.queue.splice(index, 1);
      line.waiting--;
    }
    tidy(key, line, lane);
  };

  /** Runs `effect` once the connection and the person have room, before `until`, or refuses. */
  const run = <A, E, R>(
    key: Key,
    until: number,
    effect: (admitted: Admitted) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | Refused, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let line = lines.get(key.connection);
        if (line === undefined) {
          line = { running: 0, waiting: 0, lanes: new Map(), turns: [] };
          lines.set(key.connection, line);
        }
        let lane = line.lanes.get(key.person);
        if (lane === undefined) {
          lane = { running: 0, queue: [] };
          line.lanes.set(key.person, lane);
        }
        const started = yield* Clock.currentTimeMillis;
        let waitedMs = 0;
        const waitingAtEntry = line.waiting;
        if (line.running < limits.concurrent && lane.running < limits.perPerson) {
          line.running++;
          lane.running++;
        } else {
          const blocked =
            line.running >= limits.concurrent
              ? { limit: "concurrent" as const, value: limits.concurrent }
              : { limit: "perPerson" as const, value: limits.perPerson };
          const full =
            line.waiting >= limits.waiting
              ? { limit: "waiting" as const, value: limits.waiting }
              : lane.queue.length >= limits.perPersonWaiting
                ? { limit: "personWaiting" as const, value: limits.perPersonWaiting }
                : until <= started
                  ? blocked
                  : undefined;
          if (full !== undefined) {
            tidy(key, line, lane);
            return yield* new Refused({ ...full, waitedMs: 0 });
          }
          const waiter: Waiter = { deferred: Deferred.makeUnsafe<void>(), granted: false };
          lane.queue.push(waiter);
          line.waiting++;
          if (!line.turns.includes(key.person)) line.turns.push(key.person);
          const taken = yield* restore(
            Deferred.await(waiter.deferred).pipe(Effect.timeoutOption(until - started))
          ).pipe(Effect.onInterrupt(() => Effect.sync(() => abandon(key, line, lane, waiter))));
          waitedMs = (yield* Clock.currentTimeMillis) - started;
          if (Option.isNone(taken)) {
            abandon(key, line, lane, waiter);
            return yield* new Refused({ ...blocked, waitedMs });
          }
        }
        const admitted = { waitedMs, running: line.running, waiting: waitingAtEntry };
        return yield* restore(Effect.suspend(() => effect(admitted))).pipe(
          Effect.ensuring(Effect.sync(() => leave(key, line, lane)))
        );
      })
    );

  return { limits, run };
};

export type Gate = ReturnType<typeof make>;

const names: ReadonlyArray<string> = [
  "concurrent",
  "perPerson",
  "waiting",
  "perPersonWaiting"
] satisfies ReadonlyArray<keyof Limits>;
const isName = (name: string | undefined): name is keyof Limits =>
  name !== undefined && names.includes(name);

/** Reads `concurrent=16,perPerson=4,...` over `defaults`; an unknown name or a value under 1 reads nothing. */
export const parseLimits = (text: string, defaults: Limits): Limits | undefined => {
  const parsed: { -readonly [K in keyof Limits]: number } = { ...defaults };
  for (const part of text.split(",")) {
    if (part.trim() === "") continue;
    const [name, value] = part.split("=").map((piece) => piece.trim());
    const number = Number(value);
    if (!isName(name) || !Number.isInteger(number) || number < 1) return undefined;
    parsed[name] = number;
  }
  return parsed;
};
