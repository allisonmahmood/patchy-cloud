/**
 * PROTOTYPE: how one host replica counts tier 2 action slots, `tier2.actions.company` and
 * `tier2.actions.viewer`, in one of three modes chosen at server start:
 *
 * - `today`: an action holds its slots for its whole life, model calls included.
 * - `park-r1`: an action awaiting a model call is parked and holds no slot. When the answer
 *   comes back it counts again at once, so the running count can pass the cap by however many
 *   resume together.
 * - `park-r2`: parked as in `park-r1`, but the answer is held until a slot is free, within the
 *   action's own deadline. Freed slots go to held answers oldest first, skipping one whose person
 *   is still at their cap; a held answer never waits behind a new action, because a slot freed
 *   while answers wait is handed over before anything else can run.
 * - `pool`: admitted to the ordinary slots as today. The first time an action makes a model call
 *   it takes a place in a separate model-action pool, with its own caps per company and per
 *   person, and gives its ordinary slots up at once; it stays in the pool until it ends, whatever
 *   it does afterwards. The move is one-way, once per action. With the pool full, that model call
 *   is refused `busy` before anything is sent and the action keeps its ordinary slot; a later
 *   model call of the same action tries again.
 *
 * Admission is refused at once with `busy` when a cap is full, in every mode; nothing queues in
 * front of an action. The counts live in this replica's memory, as they do today. Every mode
 * tracks parked time, so `today` reports how long its slots sat idle on model calls.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const modes = ["today", "park-r1", "park-r2", "pool"] as const;
export type Mode = (typeof modes)[number];

export interface Limits {
  readonly company: number;
  readonly viewer: number;
}

/** `pool`: how many actions per company, and per person, may be in the model-action pool. */
export interface PoolLimits {
  readonly company: number;
  readonly person: number;
}
/**
 * The pool's starting numbers, per replica. 24 a company keeps one company's waiting model calls
 * on its execution task near 50 with two replicas, a fifth of Bun's 256 simultaneous fetches per
 * process at two fetches each; 4 a person matches the provider gate's share.
 */
export const POOL: PoolLimits = { company: 24, person: 4 };

/** `pool`: the model-action pool was full, so this model call was refused and nothing was sent. */
export class PoolBusy extends Schema.TaggedError<PoolBusy>()("ActionSlotsPoolBusy", {
  limitId: Schema.Literals(["tier2.models.company", "tier2.models.person"]),
  value: Schema.Number
}) {
  readonly code = "busy" as const;
  readonly status = 429;
  readonly retryAfterSeconds = 1;
  get scope() {
    return this.limitId === "tier2.models.company" ? ("company" as const) : ("viewer" as const);
  }
  override get message() {
    return this.limitId === "tier2.models.company"
      ? `This company already has ${this.value} actions waiting on model calls, so Patchy sent nothing. Try again shortly.`
      : `You already have ${this.value} actions waiting on model calls, so Patchy sent nothing. Try again shortly.`;
  }
}

/** What one action's wide event records about its slots. */
export interface Report {
  readonly mode: Mode;
  /** How many times the action parked: once per run of overlapping model calls. */
  parks: number;
  /** Time spent awaiting model calls, held slot or not. */
  parkedMs: number;
  /** `park-r2`: time an answer was held waiting for a slot. */
  resumeWaitMs: number;
  /** The company's running actions at the highest point this action saw (admission, resumes). */
  running: number;
  /** The company's parked actions at the highest point this action saw (each park). */
  parked: number;
  /** `park-r2`: answers held across the replica at the highest point this action saw. */
  held: number;
  /** `pool`: the company's pooled actions when this one moved in, or 0. */
  pooled: number;
  /** `pool`: model calls refused because the pool was full. */
  poolRefused: number;
  /** When the action got going again after its last model call answered, in epoch ms, or 0. */
  resumedAt: number;
}

export interface Slot {
  /**
   * Runs one model call parked: the action's slots are free while it waits, taken back after; or
   * in `pool`, the action moves to the pool first, or the call is refused.
   */
  readonly park: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | PoolBusy, R>;
  /** Frees the action's slots at its end, however it ended. Safe to run twice. */
  readonly release: Effect.Effect<void>;
  readonly report: Report;
}

export interface Admission {
  /** Running actions each cap already counted, before this one. */
  readonly used: Limits;
  /** The cap that refused, or the admitted action's slot. */
  readonly result:
    | { readonly refused: "company" | "viewer" }
    | { readonly refused?: undefined; readonly slot: Slot };
}

interface State {
  readonly company: string;
  readonly viewer: string;
  readonly person: string;
  readonly limits: Limits;
  /** Whether the action holds its slots now. */
  counted: boolean;
  /** `pool`: whether the action has moved to the pool. */
  pooled: boolean;
  /** Model calls in flight; the action is parked while this is above zero. */
  inFlight: number;
  parkedSince: number;
  ended: boolean;
  readonly report: Report;
}

interface Held {
  readonly state: State;
  readonly deferred: Deferred.Deferred<void>;
}

/** One replica's slot counts. `Invocation` makes one; nothing else counts actions. */
export const make = (mode: Mode, poolLimits: PoolLimits = POOL) => {
  const running = new Map<string, number>();
  const viewers = new Map<string, number>();
  const parked = new Map<string, number>();
  const poolCompanies = new Map<string, number>();
  const poolPeople = new Map<string, number>();
  const held: Array<Held> = [];
  const parks = mode === "park-r1" || mode === "park-r2";

  const bump = (counts: Map<string, number>, key: string, by: number) => {
    const next = (counts.get(key) ?? 0) + by;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
    return next;
  };
  const room = (state: State) =>
    (running.get(state.company) ?? 0) < state.limits.company &&
    (viewers.get(state.viewer) ?? 0) < state.limits.viewer;
  const count = (state: State) => {
    state.counted = true;
    const now = bump(running, state.company, 1);
    bump(viewers, state.viewer, 1);
    state.report.running = Math.max(state.report.running, now);
  };
  /**
   * Hands freed slots to held answers, oldest first, skipping one whose person is still full.
   * Waking one can run it at once, so every count is settled before anyone is woken.
   */
  const grant = () => {
    const woken: Array<Held> = [];
    for (let index = 0; index < held.length;) {
      const next = held[index]!;
      if (!room(next.state)) {
        index++;
        continue;
      }
      held.splice(index, 1);
      count(next.state);
      woken.push(next);
    }
    for (const entry of woken) Deferred.doneUnsafe(entry.deferred, Effect.void);
  };
  const uncount = (state: State) => {
    if (!state.counted) return;
    state.counted = false;
    bump(running, state.company, -1);
    bump(viewers, state.viewer, -1);
    grant();
  };

  /** `viewer` is the action's slot key; `person` keys the pool, across the person's patches. */
  const admit = (company: string, viewer: string, person: string, limits: Limits): Admission => {
    const used = { company: running.get(company) ?? 0, viewer: viewers.get(viewer) ?? 0 };
    if (used.company >= limits.company) return { used, result: { refused: "company" } };
    if (used.viewer >= limits.viewer) return { used, result: { refused: "viewer" } };
    const state: State = {
      company,
      viewer,
      person,
      limits,
      counted: false,
      pooled: false,
      inFlight: 0,
      parkedSince: 0,
      ended: false,
      report: {
        mode,
        parks: 0,
        parkedMs: 0,
        resumeWaitMs: 0,
        running: 0,
        parked: 0,
        held: 0,
        pooled: 0,
        poolRefused: 0,
        resumedAt: 0
      }
    };
    count(state);

    /** Takes the slots back after the last model call in flight answered. */
    const resume = (restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if (state.counted || state.ended || state.inFlight > 0) return;
        if (mode === "park-r1" || room(state)) return count(state);
        const entry: Held = { state, deferred: Deferred.makeUnsafe<void>() };
        held.push(entry);
        state.report.held = Math.max(state.report.held, held.length);
        const started = yield* Clock.currentTimeMillis;
        yield* restore(Deferred.await(entry.deferred)).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const index = held.indexOf(entry);
              if (index !== -1) held.splice(index, 1);
              state.report.resumeWaitMs += (yield* Clock.currentTimeMillis) - started;
            })
          )
        );
      });

    /** `pool`: moves the action into the pool, or refuses with the cap that is full. */
    const enterPool = () => {
      if (state.pooled || state.ended) return undefined;
      const inCompany = poolCompanies.get(company) ?? 0;
      if (inCompany >= poolLimits.company)
        return new PoolBusy({ limitId: "tier2.models.company", value: poolLimits.company });
      if ((poolPeople.get(person) ?? 0) >= poolLimits.person)
        return new PoolBusy({ limitId: "tier2.models.person", value: poolLimits.person });
      state.pooled = true;
      state.report.pooled = bump(poolCompanies, company, 1);
      bump(poolPeople, person, 1);
      uncount(state);
      return undefined;
    };

    const park = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | PoolBusy, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (mode === "pool") {
            const refused = enterPool();
            if (refused !== undefined) {
              state.report.poolRefused++;
              return yield* refused;
            }
          }
          if (state.inFlight++ === 0) {
            state.parkedSince = yield* Clock.currentTimeMillis;
            state.report.parks++;
            state.report.parked = Math.max(state.report.parked, bump(parked, company, 1));
            if (parks) uncount(state);
          }
          const exit = yield* Effect.exit(restore(effect));
          if (--state.inFlight === 0) {
            state.report.parkedMs += (yield* Clock.currentTimeMillis) - state.parkedSince;
            bump(parked, company, -1);
            // An interrupted call means the action is ending: nothing to resume.
            if (parks && !(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)))
              yield* resume(restore);
            if (state.inFlight === 0) state.report.resumedAt = yield* Clock.currentTimeMillis;
          }
          return yield* exit;
        })
      );

    const release = Effect.sync(() => {
      if (state.ended) return;
      state.ended = true;
      // An answer still held is let go; its action is over.
      const mine = held.filter((entry) => entry.state === state);
      for (const entry of mine) held.splice(held.indexOf(entry), 1);
      if (state.pooled) {
        state.pooled = false;
        bump(poolCompanies, company, -1);
        bump(poolPeople, person, -1);
      }
      uncount(state);
      for (const entry of mine) Deferred.doneUnsafe(entry.deferred, Effect.void);
    });

    return { used, result: { slot: { park, release, report: state.report } } };
  };

  return { mode, admit };
};
