// @effect-diagnostics nodeBuiltinImport:off -- Node supplies opaque cryptographic capability tokens.
import { randomBytes } from "node:crypto";
import {
  limitRefusal,
  type HandlerKind,
  type RuntimeFailure,
  type RuntimeMe,
  type ServerCallReply
} from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as DatabaseMeter from "@patchy/analytics/database-meter";
import { ContractLimits, DeploymentConfig } from "@patchy/limits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Binding from "./Binding.js";
import type { RuntimeError } from "./Runtime.js";
import type { Resource } from "./QuerySnapshot.js";
import type * as MutationTransaction from "./MutationTransaction.js";

export type EndReason = "returned" | "deadline" | "superseded" | "process_killed";
export type AttemptIdentity = Pick<
  GuestProtocol.Attempt,
  "invocationId" | "attemptId" | "processGeneration"
>;
export interface TreeBudget {
  bytes: number;
}
export interface Counters {
  callbacks: number;
  logBytes: number;
  outstanding: number;
  peakOutstanding: number;
  peakBytes: number;
  peakLogBytes: number;
  peakFileBytes: number;
  readonly operations: Set<string>;
  readonly logs: Array<Schema.Json>;
}
export interface Capability {
  readonly token: string;
  readonly binding: Binding.Binding["Service"];
  readonly attempt: GuestProtocol.Attempt;
  readonly kind: HandlerKind;
  readonly reauthorize: Effect.Effect<NonNullable<RuntimeMe>, RuntimeError>;
  readonly tree: TreeBudget;
  readonly counters: Counters;
  readonly logs: Array<Schema.Json>;
  readonly refusals: Array<{ readonly failure: RuntimeFailure; readonly status: number }>;
  readonly run?: (args: unknown) => Effect.Effect<ServerCallReply, RuntimeError>;
  readonly snapshot: { value?: Resource };
  readonly mutation: { value?: MutationTransaction.Resource };
  readonly observe: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export interface Issue {
  readonly binding: Binding.Binding["Service"];
  readonly attempt: GuestProtocol.Attempt;
  readonly kind: HandlerKind;
  readonly reauthorize: Effect.Effect<NonNullable<RuntimeMe>, RuntimeError>;
  readonly tree?: TreeBudget;
  readonly counters?: Counters;
  readonly run?: (args: unknown) => Effect.Effect<ServerCallReply, RuntimeError>;
}

/** Owners signal settled only after the commit or cancellation outcome is known. */
export interface RetainedResource {
  readonly cancel: Effect.Effect<void>;
  readonly settled: Effect.Effect<void>;
  /** Synchronously fences disposal and prevents returning this resource to a pool. */
  readonly destroy: () => void;
}

export class CapabilityRefused extends Schema.TaggedError<CapabilityRefused>()(
  "CapabilityRefused",
  {
    reason: Schema.Literals([
      "unknown",
      "attempt_mismatch",
      "returned",
      "deadline",
      "superseded",
      "process_killed"
    ])
  }
) {
  override get message() {
    return `Invocation capability refused: ${this.reason}.`;
  }
  get failure(): RuntimeFailure {
    return { ok: false, source: "patchy", code: "access_denied", error: this.message };
  }
}

export class InvocationCapabilities extends Context.Service<
  InvocationCapabilities,
  {
    readonly issue: (input: Issue) => Effect.Effect<Capability>;
    readonly resolve: (
      token: string,
      attempt: AttemptIdentity
    ) => Effect.Effect<Capability, CapabilityRefused>;
    readonly end: (token: string, reason: EndReason) => Effect.Effect<void>;
    /** Fences queued work, cancels running work, then waits only up to the cleanup bound. */
    readonly settle: (
      token: string,
      reason: EndReason,
      cleanupMs?: number
    ) => Effect.Effect<boolean>;
    readonly retain: (
      token: string,
      attempt: AttemptIdentity,
      resource: RetainedResource
    ) => Effect.Effect<void, CapabilityRefused>;
    /** Tracks effects separately from callback fibers, whose interruption is not non-commit. */
    readonly performEffect: <A, E, R>(
      capability: Capability,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | CapabilityRefused, R>;
    readonly chargeCallback: (capability: Capability) => RuntimeFailure | undefined;
    readonly chargeBytes: (capability: Capability, bytes: number) => RuntimeFailure | undefined;
    readonly rememberRefusal: (
      capability: Capability,
      failure: RuntimeFailure,
      status: number
    ) => RuntimeFailure;
    readonly execute: <A, E, R>(
      capability: Capability,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | CapabilityRefused, R>;
  }
>()("@patchy/runtime/InvocationCapabilities") {}

export const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const deployment = yield* DeploymentConfig.load;
  const tombstoneMs = deployment.get("tier2.capability.tombstone");
  const cleanupMs = yield* ContractLimits.get("tier2.settlement.cleanup");
  const outstanding = yield* ContractLimits.get("tier2.callbacks.outstanding");
  const countLimit = yield* ContractLimits.get("tier2.callbacks.count");
  const byteLimit = yield* ContractLimits.get("tier2.callbacks.bytes");
  const rememberRefusal: InvocationCapabilities["Service"]["rememberRefusal"] = (
    capability,
    failure,
    status
  ) => {
    if (
      capability.refusals.length <= countLimit &&
      !capability.refusals.some((entry) => entry.failure === failure)
    )
      capability.refusals.push({ failure, status });
    return failure;
  };
  const chargeCallback: InvocationCapabilities["Service"]["chargeCallback"] = (capability) => {
    capability.counters.callbacks++;
    if (capability.counters.callbacks > countLimit)
      return rememberRefusal(
        capability,
        {
          ok: false,
          source: "patchy",
          error: "The invocation callback count is exhausted.",
          ...limitRefusal("tier2.callbacks.count", countLimit)
        },
        429
      );
  };
  const chargeBytes: InvocationCapabilities["Service"]["chargeBytes"] = (capability, bytes) => {
    capability.counters.peakBytes = Math.max(
      capability.counters.peakBytes,
      capability.tree.bytes + bytes
    );
    if (capability.tree.bytes + bytes > byteLimit)
      return rememberRefusal(
        capability,
        {
          ok: false,
          source: "patchy",
          error: "The invocation callback bytes are exhausted.",
          ...limitRefusal("tier2.callbacks.bytes", byteLimit)
        },
        429
      );
    capability.tree.bytes += bytes;
  };
  interface Retained {
    readonly resource: RetainedResource;
    readonly watcher: Fiber.Fiber<void>;
    cancellation?: Fiber.Fiber<void>;
    destroyed: boolean;
  }
  const resourceSettled = (retained: Retained) => {
    const outcome = retained.watcher.pollUnsafe();
    const cancellation = retained.cancellation?.pollUnsafe();
    return (
      outcome !== undefined &&
      Exit.isSuccess(outcome) &&
      (retained.cancellation === undefined ||
        (cancellation !== undefined && Exit.isSuccess(cancellation)))
    );
  };
  interface Entry {
    readonly capability: Capability;
    readonly gate: Semaphore.Semaphore;
    readonly ended: Deferred.Deferred<EndReason>;
    readonly fibers: Set<Fiber.Fiber<unknown, unknown>>;
    readonly resources: Set<Retained>;
    effectsStarted: boolean;
    effectsPending: number;
    effectsUncertain: boolean;
    timer?: Fiber.Fiber<void>;
    reason?: EndReason;
    expiresAt?: number;
  }
  const entries = new Map<string, Entry>();
  const tombstones = new Map<
    string,
    {
      readonly attempt: GuestProtocol.Attempt;
      readonly reason: EndReason;
      readonly expiresAt: number;
      readonly settled: boolean;
    }
  >();
  const fence = Effect.fnUntraced(function* (entry: Entry, reason: EndReason) {
    if (entry.reason !== undefined) return;
    entry.reason = reason;
    entry.expiresAt = (yield* Clock.currentTimeMillis) + tombstoneMs;
    yield* Deferred.succeed(entry.ended, reason);
    for (const fiber of entry.fibers) fiber.interruptUnsafe();
    for (const retained of entry.resources)
      if (retained.watcher.pollUnsafe() === undefined)
        retained.cancellation = yield* retained.resource.cancel.pipe(Effect.forkIn(scope));
  });
  const end = Effect.fn("InvocationCapabilities.end")(function* (token: string, reason: EndReason) {
    const entry = entries.get(token);
    if (entry !== undefined) yield* fence(entry, reason);
  });
  const resolve = Effect.fn("InvocationCapabilities.resolve")(function* (
    token: string,
    attempt: AttemptIdentity
  ) {
    const entry = entries.get(token);
    if (entry === undefined) {
      const tombstone = tombstones.get(token);
      if (tombstone === undefined || tombstone.expiresAt <= (yield* Clock.currentTimeMillis))
        return yield* new CapabilityRefused({ reason: "unknown" });
      const expected = tombstone.attempt;
      return yield* new CapabilityRefused({
        reason:
          expected.invocationId === attempt.invocationId &&
          expected.attemptId === attempt.attemptId &&
          expected.processGeneration === attempt.processGeneration
            ? tombstone.reason
            : "attempt_mismatch"
      });
    }
    const expected = entry.capability.attempt;
    if (
      expected.invocationId !== attempt.invocationId ||
      expected.attemptId !== attempt.attemptId ||
      expected.processGeneration !== attempt.processGeneration
    )
      return yield* new CapabilityRefused({ reason: "attempt_mismatch" });
    if (entry.reason === undefined && (yield* Clock.currentTimeMillis) >= expected.deadline)
      yield* fence(entry, "deadline");
    if (entry.reason !== undefined) return yield* new CapabilityRefused({ reason: entry.reason });
    return entry.capability;
  });
  const issue = Effect.fn("InvocationCapabilities.issue")(function* (input: Issue) {
    const counters: Counters = input.counters ?? {
      callbacks: 0,
      logBytes: 0,
      logs: [],
      outstanding: 0,
      peakOutstanding: 0,
      peakBytes: 0,
      peakLogBytes: 0,
      peakFileBytes: 0,
      operations: new Set()
    };
    const observe = yield* WideEvents.capture;
    const meter = yield* DatabaseMeter.current;
    const capability: Capability = Object.freeze({
      token: randomBytes(32).toString("base64url"),
      binding: Object.freeze({
        ...input.binding,
        ...(input.binding.identity === null
          ? {}
          : {
              identity: Object.freeze({
                ...input.binding.identity,
                user: Object.freeze({ ...input.binding.identity.user }),
                company: Object.freeze({ ...input.binding.identity.company })
              })
            })
      }),
      attempt: Object.freeze({ ...input.attempt }),
      kind: input.kind,
      reauthorize: input.reauthorize,
      tree: input.tree ?? { bytes: 0 },
      snapshot: {},
      mutation: {},
      observe: <A, E, R>(work: Effect.Effect<A, E, R>) =>
        observe(work.pipe(Effect.provideService(DatabaseMeter.current, meter))),
      ...(input.run === undefined ? {} : { run: input.run }),
      counters,
      logs: counters.logs,
      refusals: []
    });
    const entry: Entry = {
      capability,
      gate: Semaphore.makeUnsafe(outstanding),
      ended: yield* Deferred.make<EndReason>(),
      fibers: new Set(),
      resources: new Set(),
      effectsStarted: false,
      effectsPending: 0,
      effectsUncertain: false
    };
    entries.set(capability.token, entry);
    const remaining = capability.attempt.deadline - (yield* Clock.currentTimeMillis);
    entry.timer = yield* Effect.sleep(Math.max(0, remaining)).pipe(
      Effect.andThen(fence(entry, "deadline")),
      Effect.forkIn(scope)
    );
    return capability;
  });
  const retain = Effect.fn("InvocationCapabilities.retain")(function* (
    token: string,
    attempt: AttemptIdentity,
    resource: RetainedResource
  ) {
    yield* resolve(token, attempt);
    const entry = entries.get(token)!;
    const watcher = yield* resource.settled.pipe(Effect.forkIn(scope));
    const retained: Retained = { resource, watcher, destroyed: false };
    entry.resources.add(retained);
    if (entry.reason !== undefined)
      retained.cancellation = yield* resource.cancel.pipe(Effect.forkIn(scope));
  });
  const performEffect: InvocationCapabilities["Service"]["performEffect"] = (capability, effect) =>
    Effect.gen(function* () {
      yield* resolve(capability.token, capability.attempt);
      const entry = entries.get(capability.token)!;
      entry.effectsStarted = true;
      entry.effectsPending++;
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            entry.effectsPending--;
            if (
              Exit.isFailure(exit) &&
              (Cause.hasInterrupts(exit.cause) || Cause.hasDies(exit.cause))
            )
              entry.effectsUncertain = true;
          })
        )
      );
    });
  const execute = <A, E, R>(capability: Capability, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      yield* resolve(capability.token, capability.attempt);
      const entry = entries.get(capability.token)!;
      const queuedAt = yield* Clock.currentTimeMillis;
      const job = entry.gate.withPermits(1)(
        Effect.gen(function* () {
          yield* resolve(capability.token, capability.attempt);
          yield* capability.observe(
            WideEvents.add({
              queueWaitMs: Math.max(0, (yield* Clock.currentTimeMillis) - queuedAt)
            })
          );
          capability.counters.outstanding++;
          capability.counters.peakOutstanding = Math.max(
            capability.counters.peakOutstanding,
            capability.counters.outstanding
          );
          return yield* capability.observe(effect).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                capability.counters.outstanding--;
              })
            )
          );
        })
      );
      // The service owns callback effects, not the HTTP request that waits for their reply.
      const fiber = yield* Effect.forkIn(job, scope);
      entry.fibers.add(fiber);
      fiber.addObserver(() => entry.fibers.delete(fiber));
      const value = yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit): Effect.Effect<A, E | CapabilityRefused> => {
          if (entry.reason !== undefined)
            return Effect.fail(new CapabilityRefused({ reason: entry.reason }));
          return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
        }),
        Effect.raceFirst(
          Deferred.await(entry.ended).pipe(
            Effect.flatMap((reason) => Effect.fail(new CapabilityRefused({ reason })))
          )
        )
      );
      yield* resolve(capability.token, capability.attempt);
      return value;
    });
  const settle = Effect.fn("InvocationCapabilities.settle")(function* (
    token: string,
    reason: EndReason,
    bound = cleanupMs
  ) {
    const entry = entries.get(token);
    if (entry === undefined) return tombstones.get(token)?.settled ?? true;
    yield* fence(entry, reason);
    const result = yield* Effect.all([
      Fiber.awaitAll(entry.fibers),
      Fiber.awaitAll(
        Array.from(entry.resources).flatMap(({ watcher, cancellation }) =>
          cancellation === undefined ? [watcher] : [watcher, cancellation]
        )
      )
    ]).pipe(Effect.timeoutOption(Math.max(0, bound)));
    let settled =
      Option.isSome(result) &&
      entry.effectsPending === 0 &&
      !entry.effectsUncertain &&
      (entry.capability.kind === "mutation" ||
        entry.reason === "returned" ||
        !entry.effectsStarted);
    for (const retained of entry.resources) {
      if (!resourceSettled(retained)) {
        settled = false;
        if (!retained.destroyed) {
          retained.destroyed = true;
          retained.resource.destroy();
        }
      }
      retained.watcher.interruptUnsafe();
      retained.cancellation?.interruptUnsafe();
    }
    for (const fiber of entry.fibers) fiber.interruptUnsafe();
    entry.timer?.interruptUnsafe();
    tombstones.set(token, {
      attempt: entry.capability.attempt,
      reason: entry.reason!,
      expiresAt: entry.expiresAt!,
      settled
    });
    // The invocation owner still has its log counters; replay storage retains no
    // manifest, session resolver, callback result, or retained connection.
    entries.delete(token);
    return settled;
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const entry of entries.values()) {
        yield* fence(entry, "process_killed");
        for (const retained of entry.resources) {
          if (!retained.destroyed && !resourceSettled(retained)) {
            retained.destroyed = true;
            retained.resource.destroy();
          }
          retained.watcher.interruptUnsafe();
          retained.cancellation?.interruptUnsafe();
        }
      }
      entries.clear();
      tombstones.clear();
    })
  );
  // Finished entries retain only bounded invocation data for the replay window.
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Math.min(tombstoneMs, 1_000));
      const now = yield* Clock.currentTimeMillis;
      for (const [token, entry] of entries) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now && entry.fibers.size === 0) {
          entry.timer?.interruptUnsafe();
          for (const retained of entry.resources) retained.watcher.interruptUnsafe();
          entries.delete(token);
        }
      }
      for (const [token, tombstone] of tombstones)
        if (tombstone.expiresAt <= now) tombstones.delete(token);
    }
  }).pipe(Effect.forkIn(scope));
  return InvocationCapabilities.of({
    issue,
    resolve,
    end,
    settle,
    execute,
    retain,
    performEffect,
    chargeCallback,
    chargeBytes,
    rememberRefusal
  });
});

export const layer = Layer.effect(InvocationCapabilities, make);
