// @effect-diagnostics nodeBuiltinImport:off -- Mutation keys use host cryptographic randomness.
import { createHash, randomBytes } from "node:crypto";
import { canonicalArgs, type ServerCallReply } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Binding from "./Binding.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as Runtime from "./Runtime.js";

export class WriteConflict extends Schema.TaggedError<WriteConflict>()("WriteConflict", {
  scope: Schema.Literal("viewer"),
  limitId: Schema.Literal("tier2.mutation.attempts"),
  value: Schema.Number
}) {
  readonly code = "write_conflict" as const;
  readonly status = 409;
  override get message() {
    return `The mutation could not serialize after ${this.value} attempts.`;
  }
}
export class SerializationConflict extends Schema.TaggedError<SerializationConflict>()(
  "SerializationConflict",
  {
    cause: Schema.Defect()
  }
) {}
export class KeyRace extends Schema.TaggedError<KeyRace>()("MutationKeyRace", {
  cause: Schema.Defect()
}) {}
export class CommitUnknown extends Schema.TaggedError<CommitUnknown>()("MutationCommitUnknown", {
  cause: Schema.Defect()
}) {
  readonly code = "unknown_outcome" as const;
  readonly status = 503;
  override get message() {
    return "The mutation commit has not been acknowledged. Retry with its mutation key.";
  }
}
export type Failure = Runtime.RuntimeError | SerializationConflict | KeyRace;
export interface Key {
  readonly key: string;
  readonly issuedAt: number;
  readonly patchId: string;
  readonly versionId: string;
  readonly handler: string;
  readonly viewerId: string;
  readonly fingerprint: string;
}
export const mint = Effect.map(
  Clock.currentTimeMillis,
  (now) => `${now}-${randomBytes(16).toString("base64url")}`
);
const keySchema = Schema.String.check(Schema.isPattern(/^\d{1,16}-[A-Za-z0-9_-]{22}$/));
const decodeKey = Schema.decodeUnknownEffect(keySchema);
export const key = Effect.fnUntraced(function* (
  value: unknown,
  binding: Binding.Binding["Service"],
  handler: string,
  args: unknown
) {
  const encoded = yield* decodeKey(value).pipe(
    Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
  );
  const issuedAt = Number(encoded.slice(0, encoded.indexOf("-")));
  const now = yield* Clock.currentTimeMillis;
  const lifetime = yield* ContractLimits.get("tier2.mutation.keyLifetime");
  const futureSkew = yield* ContractLimits.get("tier2.mutation.keyFutureSkew");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < now - lifetime || issuedAt > now + futureSkew)
    return yield* new Runtime.InvalidRequest({});
  return {
    key: encoded,
    issuedAt,
    patchId: binding.patchId,
    versionId: binding.versionId,
    handler,
    viewerId: binding.identity!.user.id,
    fingerprint: createHash("sha256").update(canonicalArgs(args)).digest("hex")
  } satisfies Key;
});

export interface Session {
  readonly context: Context.Context<never>;
  readonly uncertain: boolean;
  readonly save: (key: Key, reply: ServerCallReply) => Effect.Effect<ServerCallReply, Failure>;
  readonly commit: Effect.Effect<void, Failure>;
  readonly rollback: Effect.Effect<void>;
  readonly publish: Effect.Effect<void>;
  readonly destroy: () => void;
}
/** A matching committed key proves the originating invocation's validated success. */
export interface StoredOutcome {
  readonly invocationId: string;
  readonly reply: ServerCallReply;
}
/** Storage and connection ownership are supplied by Primitives, never imported by Runtime. */
export class MutationTransaction extends Context.Service<
  MutationTransaction,
  {
    readonly lookup: (
      binding: Binding.Binding["Service"],
      key: Key
    ) => Effect.Effect<StoredOutcome | undefined, Runtime.RuntimeError>;
    readonly open: (
      capability: InvocationCapabilities.Capability
    ) => Effect.Effect<Session, Failure, Scope.Scope>;
  }
>()("@patchy/runtime/MutationTransaction") {}

export interface Resource extends InvocationCapabilities.RetainedResource {
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | Failure | InvocationCapabilities.CapabilityRefused, R>;
  readonly complete: (
    reply: ServerCallReply
  ) => Effect.Effect<ServerCallReply, Failure | InvocationCapabilities.CapabilityRefused>;
  readonly close: () => void;
  readonly abort: (cause: unknown) => void;
  readonly conflict: SerializationConflict | undefined;
  /** The validated reply is authoritative once this owner has acknowledged COMMIT. */
  readonly committedReply: ServerCallReply | undefined;
  readonly uncertain: boolean;
}

/** The owner is the only fiber executing SQL. Returning closes admission before result validation. */
export const make = Effect.fnUntraced(function* (
  capability: InvocationCapabilities.Capability,
  mutationKey: Key,
  scope: Scope.Scope
) {
  const storage = yield* MutationTransaction;
  const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
  const cleanup = yield* ContractLimits.get("tier2.settlement.cleanup");
  const jobs = yield* Queue.unbounded<Effect.Effect<void>>();
  const settled = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<void, Failure>();
  const completion = yield* Deferred.make<
    ServerCallReply,
    Failure | InvocationCapabilities.CapabilityRefused
  >();
  const pending = new Set<() => void>();
  let owner: Fiber.Fiber<void, Failure> | undefined;
  let starting = false;
  let session: Session | undefined;
  let closed = false;
  let cancelled = false;
  let conflict: SerializationConflict | undefined;
  let committedReply: ServerCallReply | undefined;
  let finalReply: ServerCallReply | undefined;
  const refused = () => new InvocationCapabilities.CapabilityRefused({ reason: "returned" });
  const close = () => {
    closed = true;
    for (const refuse of pending) refuse();
    pending.clear();
  };
  const start = Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() =>
      starting
        ? restore(Deferred.await(ready))
        : Effect.gen(function* () {
            starting = true;
            owner = yield* Effect.gen(function* () {
              session = yield* storage.open(capability);
              yield* Deferred.succeed(ready, undefined);
              while (finalReply === undefined) yield* Queue.take(jobs).pipe(Effect.flatten);
              if (conflict !== undefined) return yield* conflict;
              const reply = yield* session.save(mutationKey, finalReply);
              yield* session.commit;
              committedReply = reply;
              yield* Deferred.succeed(completion, reply);
            }).pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  close();
                  if (committedReply === undefined && session !== undefined)
                    yield* session.rollback;
                  if (Exit.isFailure(exit)) {
                    yield* Deferred.failCause(ready, exit.cause);
                    yield* Deferred.failCause(completion, exit.cause);
                  }
                })
              ),
              Effect.scoped,
              Effect.ensuring(Deferred.succeed(settled, undefined)),
              // Wakes are hints, not settlement: release the lease before starting their delivery.
              Effect.onExit(() =>
                Effect.gen(function* () {
                  if (committedReply === undefined || session === undefined) return;
                  const remaining = Math.max(
                    0,
                    capability.attempt.deadline + cleanup - (yield* Clock.currentTimeMillis)
                  );
                  yield* session.publish.pipe(
                    Effect.timeoutOption(remaining),
                    Effect.interruptible,
                    Effect.forkIn(scope)
                  );
                })
              ),
              Effect.interruptible,
              Effect.forkIn(scope)
            );
            if (cancelled) owner.interruptUnsafe();
            yield* restore(Deferred.await(ready));
          })
    )
  );
  const resource: Resource = {
    get conflict() {
      return conflict;
    },
    get committedReply() {
      return committedReply;
    },
    get uncertain() {
      return session?.uncertain ?? false;
    },
    close,
    abort: (cause) => {
      if (isSerializationCause(cause)) {
        conflict ??= new SerializationConflict({ cause });
        close();
      }
    },
    run: (effect) =>
      Effect.gen(function* () {
        if (closed) return yield* refused();
        yield* start;
        if (closed) return yield* refused();
        const caller = yield* Effect.context<Effect.Services<typeof effect>>();
        const result = yield* Deferred.make<
          Effect.Success<typeof effect>,
          Effect.Error<typeof effect> | InvocationCapabilities.CapabilityRefused
        >();
        const refuse = () => {
          Deferred.doneUnsafe(result, Effect.fail(refused()));
        };
        pending.add(refuse);
        yield* Queue.offer(
          jobs,
          Effect.gen(function* () {
            pending.delete(refuse);
            if (closed) {
              refuse();
              return;
            }
            const exit = yield* Effect.exit(
              effect.pipe(Effect.provideContext(Context.merge(caller, session!.context)))
            );
            if (Exit.isFailure(exit) && isSerializationCause(exit.cause)) {
              conflict ??= new SerializationConflict({ cause: exit.cause });
              close();
            }
            yield* Deferred.done(result, exit);
          })
        );
        return yield* Deferred.await(result);
      }),
    complete: (reply) =>
      Effect.gen(function* () {
        if (cancelled) return yield* refused();
        close();
        yield* start;
        if (cancelled) return yield* refused();
        finalReply = reply;
        yield* Queue.offer(jobs, Effect.void);
        return yield* Deferred.await(completion);
      }),
    cancel: Effect.suspend(() => {
      cancelled = true;
      close();
      if (!starting) return Deferred.succeed(settled, undefined).pipe(Effect.asVoid);
      if (committedReply === undefined) owner?.interruptUnsafe();
      return Deferred.await(settled);
    }),
    settled: Deferred.await(settled),
    destroy: () => {
      cancelled = true;
      close();
      session?.destroy();
      owner?.interruptUnsafe();
    }
  };
  yield* capabilities.retain(capability.token, capability.attempt, resource);
  return resource;
});

const serialization = Schema.is(Schema.Struct({ code: Schema.Literal("40001") }));
export const isKeyRace = Schema.is(KeyRace);
const isConflict = Schema.is(SerializationConflict);
/** Callback errors retain their native cause through the table and runtime boundaries. */
export const isSerializationCause = (cause: unknown): boolean => {
  if (serialization(cause)) return true;
  if (typeof cause !== "object" || cause === null) return false;
  if (isConflict(cause)) return true;
  if ("cause" in cause && isSerializationCause(cause.cause)) return true;
  if ("reason" in cause && isSerializationCause(cause.reason)) return true;
  if ("reasons" in cause && Array.isArray(cause.reasons))
    return cause.reasons.some(isSerializationCause);
  if ("error" in cause && isSerializationCause(cause.error)) return true;
  if ("defect" in cause && isSerializationCause(cause.defect)) return true;
  return false;
};
