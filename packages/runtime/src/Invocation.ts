import {
  canonicalArgs,
  handlerArgsSchema,
  handlerValueSchema,
  limitRefusal,
  limitRefusalFields,
  RuntimeFailure,
  ServerCall,
  type HandlerDescriptor,
  type Manifest,
  type RuntimeMe,
  type ServerCallReply
} from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import { newInternalId } from "@patchy/core";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as DatabaseMeter from "@patchy/analytics/database-meter";
import { ContractLimits, DeploymentConfig, OperatingLimits } from "@patchy/limits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Random from "effect/Random";
import * as Binding from "./Binding.js";
import * as Executor from "./Executor.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as Runtime from "./Runtime.js";
import * as ServerBundles from "./ServerBundles.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import * as QueryRollups from "./QueryRollups.js";
import * as MutationTransaction from "./MutationTransaction.js";

export class HandlerFailed extends Schema.TaggedError<HandlerFailed>()("HandlerFailed", {
  correlationId: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  readonly code = "handler_failed" as const;
  readonly status = 500;
  override get message() {
    return "The handler failed. Use the correlation id to find its log.";
  }
}
export class HandlerTimeout extends Schema.TaggedError<HandlerTimeout>()("HandlerTimeout", {
  correlationId: Schema.String
}) {
  readonly code = "handler_timeout" as const;
  readonly status = 504;
  override get message() {
    return "The handler exceeded its deadline.";
  }
}
export class UnsettledInvocation extends Schema.TaggedError<UnsettledInvocation>()(
  "UnsettledInvocation",
  {
    correlationId: Schema.String
  }
) {
  readonly code = "unknown_outcome" as const;
  readonly status = 503;
  override get message() {
    return "The invocation's effects have not settled. Its outcome is unknown.";
  }
}
export class ResultTooLarge extends Schema.TaggedError<ResultTooLarge>()("ResultTooLarge", {
  correlationId: Schema.String,
  limitId: Schema.Literals([
    "tier2.query.resultBytes",
    "tier2.mutation.resultBytes",
    "tier2.action.resultBytes"
  ]),
  value: Schema.Number
}) {
  readonly code = "handler_failed" as const;
  readonly status = 500;
  readonly scope = "viewer" as const;
  override get message() {
    return "The handler result exceeds its byte limit.";
  }
}
export class InvocationBusy extends Schema.TaggedError<InvocationBusy>()("InvocationBusy", {
  limitId: Schema.Literals(["tier2.actions.company", "tier2.actions.viewer"]),
  value: Schema.Number,
  scope: Schema.Literals(["company", "viewer"])
}) {
  readonly code = "busy" as const;
  readonly status = 429;
  readonly retryAfterSeconds = 1;
  override get message() {
    return "The action concurrency limit is reached. Try again shortly.";
  }
}
export class ExecutorBusy extends Schema.TaggedError<ExecutorBusy>()("ExecutorBusy", {
  ...limitRefusalFields,
  cause: Schema.Defect()
}) {
  readonly code = "busy" as const;
  readonly status = 429;
  get retryAfterSeconds() {
    return this.retryAfter;
  }
  override get message() {
    return "The execution service is at capacity.";
  }
}
/** A guest may relay only the exact refusal its host issued to this attempt. */
export class CallbackRefusal extends Schema.TaggedError<CallbackRefusal>()("CallbackRefusal", {
  failure: RuntimeFailure,
  status: Schema.Number
}) {
  get code() {
    return this.failure.code;
  }
  override get message() {
    return this.failure.error;
  }
  get correlationId() {
    return this.failure.correlationId;
  }
  get limitId() {
    return this.failure.limitId;
  }
  get value() {
    return this.failure.value;
  }
  get scope() {
    return this.failure.scope;
  }
  get retryAfterSeconds() {
    return this.failure.retryAfter;
  }
  get details() {
    return this.failure.details;
  }
}

const decodeCall = Schema.decodeUnknownEffect(ServerCall, { onExcessProperty: "error" });
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const decodeReply = Schema.decodeUnknownEffect(GuestProtocol.InvokeReply, {
  onExcessProperty: "error"
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();
const isExecutionError = Schema.is(Executor.ExecutionError);
const isHandlerFailed = Schema.is(HandlerFailed);
const isCapabilityRefused = Schema.is(InvocationCapabilities.CapabilityRefused);
interface CompiledHandler {
  readonly args: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly result: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
}

interface Parent {
  readonly capability: InvocationCapabilities.Capability;
  readonly bundle: GuestProtocol.Bundle;
  readonly bound: Executor.BoundVersion;
}

// These codecs are compiled once for each retained manifest/handler, not once per callback.
const compile = (descriptor: HandlerDescriptor, manifest: typeof Manifest.Type) => ({
  args: Schema.decodeUnknownEffect(handlerArgsSchema(descriptor.args, manifest.tables), {
    onExcessProperty: "error"
  }),
  result: Schema.decodeUnknownEffect(handlerValueSchema(descriptor.result, manifest.tables), {
    onExcessProperty: "error"
  })
});

// Only await the fiber, never its cancellation finalizers. A stuck SQL driver must
// not extend the invocation's lifetime or keep its admission slot.
const awaitUntil = Effect.fnUntraced(function* <A, E>(
  effect: Effect.Effect<A, E>,
  deadline: number
) {
  const remaining = deadline - (yield* Clock.currentTimeMillis);
  if (remaining <= 0) return Option.none<Exit.Exit<A, E>>();
  const fiber = yield* Effect.forkDetach(Effect.interruptible(effect));
  return yield* Fiber.await(fiber).pipe(
    Effect.timeoutOption(remaining),
    Effect.ensuring(Effect.sync(() => fiber.interruptUnsafe()))
  );
});

export interface QueryObservation {
  readonly onDependency: (key: string) => void;
  readonly onSnapshot: (watermark: Readonly<Record<string, string>>) => void;
}

export type DevSettlement = InvocationLog.Begin & InvocationLog.Finish;

export class Invocation extends Context.Service<
  Invocation,
  {
    readonly call: (
      args: unknown,
      binding: Binding.Binding["Service"],
      reauthorize: Effect.Effect<NonNullable<RuntimeMe>, Runtime.RuntimeError>,
      observation?: QueryObservation
    ) => Effect.Effect<ServerCallReply, Runtime.RuntimeError>;
  }
>()("@patchy/runtime/Invocation") {}

interface Options {
  readonly callbackUrl: string;
  readonly dev?: { readonly observe: (settlement: DevSettlement) => Effect.Effect<void> };
}

interface PlatformBehavior {
  readonly actionLimits: (companyId: string) => Effect.Effect<
    {
      readonly company: OperatingLimits.EffectiveLimit;
      readonly viewer: OperatingLimits.EffectiveLimit;
    },
    Runtime.RuntimeError
  >;
  readonly settleQuietQuery: (record: QueryRollups.Record) => Effect.Effect<void>;
}

/** Its scope, not the HTTP request, owns admitted work and deadline settlement. */
const makeWithOptions = Effect.fn("Invocation.make")(function* (
  options: Options,
  platform?: PlatformBehavior
) {
  const scope = yield* Effect.scope;
  const executor = yield* Executor.Executor;
  const bundles = yield* ServerBundles.ServerBundles;
  const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
  const log = yield* InvocationLog.InvocationLog;
  const snapshots = yield* QuerySnapshot.QuerySnapshot;
  const mutations = yield* MutationTransaction.MutationTransaction;
  const deployment = yield* DeploymentConfig.load;
  const mutationRetryDelay = deployment.get("tier2.mutation.retryDelayMs");
  const bounds = yield* Effect.all({
    query: ContractLimits.get("tier2.query.deadline"),
    mutation: ContractLimits.get("tier2.mutation.deadline"),
    action: ContractLimits.get("tier2.action.deadline"),
    cleanup: ContractLimits.get("tier2.settlement.cleanup"),
    log: ContractLimits.get("tier2.log.bytes"),
    args: ContractLimits.get("tier2.args.bytes"),
    queryResult: ContractLimits.get("tier2.query.resultBytes"),
    mutationResult: ContractLimits.get("tier2.mutation.resultBytes"),
    mutationAttempts: ContractLimits.get("tier2.mutation.attempts"),
    actionResult: ContractLimits.get("tier2.action.resultBytes"),
    callbacks: ContractLimits.get("tier2.callbacks.count"),
    outstanding: ContractLimits.get("tier2.callbacks.outstanding"),
    callbackBytes: ContractLimits.get("tier2.callbacks.bytes"),
    fileBytes: ContractLimits.get("tier2.callbacks.fileBytes")
  });
  const codecs = new WeakMap<typeof Manifest.Type, Map<string, CompiledHandler>>();
  const companyActions = new Map<string, number>();
  const viewerActions = new Map<string, number>();

  const call = Effect.fn("Invocation.call")(function* (
    args: unknown,
    binding: Binding.Binding["Service"],
    reauthorize: Effect.Effect<NonNullable<RuntimeMe>, Runtime.RuntimeError>,
    observation?: QueryObservation,
    parent?: Parent
  ): Effect.fn.Return<ServerCallReply, Runtime.RuntimeError> {
    if (binding.scope === "public") return yield* new Runtime.PublicUnavailable({});
    if (binding.identity === null || binding.manifest.tier !== 2)
      return yield* new Runtime.AccessDenied({});
    const viewer = binding.identity;
    const input = yield* decodeCall(args).pipe(
      Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
    );
    const descriptor = binding.manifest.handlers?.[input.handler];
    if (descriptor === undefined || !Object.hasOwn(binding.manifest.handlers!, input.handler))
      return yield* new Runtime.InvalidRequest({});
    if (
      observation !== undefined &&
      (descriptor.kind !== "query" || input.mutationKey !== undefined)
    )
      return yield* new Runtime.InvalidRequest({});
    if (parent === undefined)
      yield* WideEvents.enrich({ handler: input.handler, kind: descriptor.kind });
    if (parent !== undefined) {
      yield* capabilities
        .resolve(parent.capability.token, parent.capability.attempt)
        .pipe(Effect.mapError((cause) => new Runtime.AccessDenied({ cause })));
      if (descriptor.kind === "action") return yield* new Runtime.AccessDenied({});
    }
    let cached = codecs.get(binding.manifest);
    if (cached === undefined) {
      cached = new Map();
      codecs.set(binding.manifest, cached);
    }
    let codec = cached.get(input.handler);
    if (codec === undefined) {
      codec = compile(descriptor, binding.manifest);
      cached.set(input.handler, codec);
    }
    yield* codec
      .args(input.args)
      .pipe(Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })));
    const argsBytes = encoder.encode(encodeJson(input.args)).byteLength;
    yield* WideEvents.enrich({
      limits: [
        {
          limitId: "tier2.args.bytes",
          value: bounds.args,
          peak: argsBytes,
          configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
        }
      ]
    });
    if (argsBytes > bounds.args)
      return yield* new Runtime.TooLarge({ maxBytes: bounds.args, limitId: "tier2.args.bytes" });
    const mutationKey =
      descriptor.kind === "mutation"
        ? yield* MutationTransaction.key(
            parent === undefined ? input.mutationKey : yield* MutationTransaction.mint,
            binding,
            input.handler,
            input.args
          )
        : undefined;
    const key = canonicalArgs([binding.companyId, binding.patchId, viewer.user.id]);
    const actionLimits =
      descriptor.kind === "action" && platform !== undefined
        ? yield* platform.actionLimits(binding.companyId)
        : undefined;
    const resultCodec = codec.result;
    const invoke = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (actionLimits !== undefined) {
          for (const [used, limit, limitId, limitScope] of [
            [
              companyActions.get(binding.companyId) ?? 0,
              actionLimits.company.value,
              "tier2.actions.company",
              "company"
            ],
            [
              viewerActions.get(key) ?? 0,
              actionLimits.viewer.value,
              "tier2.actions.viewer",
              "viewer"
            ]
          ] as const) {
            const effective = limitScope === "company" ? actionLimits.company : actionLimits.viewer;
            yield* WideEvents.enrich({
              limits: [
                {
                  limitId,
                  value: limit,
                  peak: Math.min(used + 1, limit),
                  configRevision: effective.configRevision
                }
              ]
            });
            if (used >= limit)
              return yield* new InvocationBusy({ limitId, value: limit, scope: limitScope });
          }
          companyActions.set(binding.companyId, (companyActions.get(binding.companyId) ?? 0) + 1);
          viewerActions.set(key, (viewerActions.get(key) ?? 0) + 1);
        }
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = Math.min(
          startedAt + bounds[descriptor.kind],
          parent?.capability.attempt.deadline ?? Infinity
        );
        const settlementDeadline = deadline + bounds.cleanup;
        const id = newInternalId("inv");
        let replyDelivered = true;
        let capability: InvocationCapabilities.Capability | undefined;
        let counters: InvocationCapabilities.Counters | undefined;
        const tree = parent?.capability.tree ?? { bytes: 0 };
        let execution:
          | Fiber.Fiber<
              ServerCallReply,
              Runtime.RuntimeError | Executor.ExecutionError | MutationTransaction.Failure
            >
          | undefined;
        let logStarted = false;
        let guestMs = 0;
        let resultBytes = 0;
        let attempts = 0;
        let storedOutcome: MutationTransaction.StoredOutcome | undefined;
        const meter = yield* DatabaseMeter.make;
        let logs: Array<typeof Schema.Json.Type> | undefined;
        let observed = false;
        const begin = {
          id,
          companyId: binding.companyId,
          patchId: binding.patchId,
          versionId: binding.versionId,
          handler: input.handler,
          kind: descriptor.kind,
          initiatingViewerId: viewer.user.id,
          parentId: parent?.capability.attempt.invocationId ?? null,
          correlationId: binding.correlationId,
          startedAt,
          deadline,
          argsBytes
        };
        const finish = Effect.fnUntraced(function* (
          outcome: InvocationLog.Finish["outcome"],
          outcomeCode: string | null,
          until: number
        ) {
          const settledAt = yield* Clock.currentTimeMillis;
          const settled: InvocationLog.Finish = {
            id,
            outcome,
            outcomeCode,
            settledAt,
            durationMs: settledAt - startedAt,
            guestMs: Math.round(guestMs),
            dbMs: Math.round(meter.snapshot()),
            callbacks: capability?.counters.callbacks ?? 0,
            resultBytes,
            attempts,
            logLines: capability?.logs ?? logs ?? [],
            replyDelivered
          };
          if (options.dev !== undefined && !observed) {
            observed = true;
            yield* options.dev.observe({
              ...begin,
              ...settled
            });
          }
          const written = yield* awaitUntil(log.finish(settled), until);
          if (Option.isNone(written))
            return yield* new UnsettledInvocation({ correlationId: binding.correlationId });
          return yield* written.value.pipe(
            Effect.mapError(
              (cause) => new Runtime.UnknownOutcome({ cause, correlationId: binding.correlationId })
            )
          );
        });
        const run = Effect.gen(function* () {
          let outcome: Exit.Exit<ServerCallReply, Runtime.RuntimeError>;
          while (true) {
            const dispatch = Effect.gen(function* () {
              if (!logStarted && (descriptor.kind !== "query" || parent !== undefined)) {
                yield* log
                  .begin(begin)
                  .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
                logStarted = true;
              }
              if (mutationKey !== undefined) {
                storedOutcome = yield* mutations.lookup(binding, mutationKey);
                if (storedOutcome !== undefined) return storedOutcome.reply;
              }
              if ((yield* Clock.currentTimeMillis) >= deadline)
                return yield* new HandlerTimeout({ correlationId: binding.correlationId });
              const bundle = parent?.bundle ?? (yield* bundles.load(binding));
              if (
                bundle.companyId !== binding.companyId ||
                bundle.patchId !== binding.patchId ||
                bundle.versionId !== (binding.executionVersionId ?? binding.versionId)
              )
                return yield* new HandlerFailed({ correlationId: binding.correlationId });
              const bound = parent?.bound ?? (yield* executor.bind(bundle));
              if (
                bound.processGeneration === undefined ||
                canonicalArgs(bound.binding) !==
                  canonicalArgs({
                    companyId: bundle.companyId,
                    patchId: bundle.patchId,
                    versionId: bundle.versionId,
                    sha256: bundle.sha256
                  })
              )
                return yield* new HandlerFailed({ correlationId: binding.correlationId });
              if (parent === undefined)
                yield* WideEvents.enrich({ processGeneration: bound.processGeneration });
              capability = yield* capabilities.issue({
                binding: { ...binding, invocationId: id, effectivePrincipal: "patch" },
                attempt: {
                  invocationId: id,
                  attemptId: newInternalId("attempt"),
                  processGeneration: bound.processGeneration,
                  deadline
                },
                kind: descriptor.kind,
                reauthorize,
                ...(observation === undefined ? {} : { onDependency: observation.onDependency }),
                tree,
                ...(counters === undefined ? {} : { counters }),
                ...(descriptor.kind !== "action"
                  ? {}
                  : {
                      run: (args: unknown) =>
                        call(
                          args,
                          { ...binding, correlationId: newInternalId("call") },
                          reauthorize,
                          undefined,
                          { capability: capability!, bundle, bound }
                        )
                    })
              });
              counters = capability.counters;
              if (descriptor.kind === "query")
                capability.snapshot.value = yield* snapshots
                  .open(capability)
                  .pipe(
                    Effect.mapError((cause) =>
                      isCapabilityRefused(cause) ? new Runtime.AccessDenied({ cause }) : cause
                    )
                  );
              if (capability.snapshot.value !== undefined)
                observation?.onSnapshot(capability.snapshot.value.watermark);
              if (mutationKey !== undefined)
                capability.mutation.value = yield* MutationTransaction.make(
                  capability,
                  mutationKey,
                  scope
                ).pipe(
                  Effect.provideService(MutationTransaction.MutationTransaction, mutations),
                  Effect.provideService(
                    InvocationCapabilities.InvocationCapabilities,
                    capabilities
                  ),
                  Effect.mapError((cause) => new Runtime.AccessDenied({ cause }))
                );
              attempts++;
              const observed = yield* executor
                .invoke({
                  wire: GuestProtocol.wireVersion,
                  binding: bound.binding,
                  ...capability.attempt,
                  handler: input.handler,
                  args: input.args,
                  viewer,
                  callback: { url: options.callbackUrl, capability: capability.token }
                })
                .pipe(
                  Effect.flatMap(decodeReply),
                  Effect.mapError((cause) =>
                    isExecutionError(cause)
                      ? cause
                      : new HandlerFailed({ correlationId: binding.correlationId, cause })
                  )
                );
              capability.mutation.value?.close();
              guestMs += observed.guestMs;
              const serializationConflict = capability.mutation.value?.conflict;
              if (serializationConflict !== undefined) return yield* serializationConflict;
              if (observed.outcome !== "returned")
                return yield* new HandlerFailed({ correlationId: binding.correlationId });
              const reply = observed.reply;
              if (!reply.ok) {
                if (reply.source === "handler") {
                  if (!descriptor.errors?.includes(reply.code))
                    return yield* new HandlerFailed({ correlationId: binding.correlationId });
                } else {
                  const trusted = capability.refusals.find(
                    (entry) => canonicalArgs(entry.failure) === canonicalArgs(reply)
                  );
                  if (trusted !== undefined) return yield* new CallbackRefusal(trusted);
                  return yield* new HandlerFailed({ correlationId: binding.correlationId });
                }
              }
              if (reply.ok)
                yield* resultCodec(reply.value).pipe(
                  Effect.mapError(
                    (cause) => new HandlerFailed({ correlationId: binding.correlationId, cause })
                  )
                );
              const value = yield* decodeJson(reply.ok ? reply.value : reply).pipe(
                Effect.mapError(
                  (cause) => new HandlerFailed({ correlationId: binding.correlationId, cause })
                )
              );
              resultBytes = encoder.encode(encodeJson(value)).byteLength;
              const maximum = bounds[`${descriptor.kind}Result`];
              if (resultBytes > maximum)
                return yield* new ResultTooLarge({
                  correlationId: binding.correlationId,
                  limitId: `tier2.${descriptor.kind}.resultBytes`,
                  value: maximum
                });
              const validated = reply.ok ? { ok: true as const, value } : reply;
              // Declared handler failures roll back writes; only validated success may commit.
              return mutationKey !== undefined && validated.ok
                ? yield* capability.mutation
                    .value!.complete(validated)
                    .pipe(
                      Effect.mapError((cause) =>
                        isCapabilityRefused(cause) ? new Runtime.AccessDenied({ cause }) : cause
                      )
                    )
                : validated;
            });
            execution = yield* Effect.forkDetach(Effect.interruptible(dispatch));
            const raced = yield* Fiber.await(execution).pipe(
              Effect.map((exit) => ({ type: "completed" as const, exit })),
              Effect.raceFirst(
                Effect.sleep(Math.max(0, deadline - (yield* Clock.currentTimeMillis))).pipe(
                  Effect.as({ type: "deadline" as const })
                )
              )
            );
            const timedOut = raced.type === "deadline";
            const raw: Exit.Exit<
              ServerCallReply,
              Runtime.RuntimeError | Executor.ExecutionError | MutationTransaction.Failure
            > =
              raced.type === "completed"
                ? raced.exit
                : Exit.fail(new HandlerTimeout({ correlationId: binding.correlationId }));
            const failure = Exit.isFailure(raw) ? Cause.findErrorOption(raw.cause) : Option.none();
            const conflict =
              capability?.mutation.value?.conflict !== undefined ||
              (Exit.isFailure(raw) && MutationTransaction.isSerializationCause(raw.cause));
            const reason: InvocationCapabilities.EndReason = timedOut
              ? "deadline"
              : conflict
                ? "superseded"
                : Option.isSome(failure) &&
                    isExecutionError(failure.value) &&
                    failure.value.reason === "process_killed"
                  ? "process_killed"
                  : "returned";
            if (timedOut) execution.interruptUnsafe();
            if (timedOut && parent === undefined)
              yield* WideEvents.enrich({ limitId: `tier2.${descriptor.kind}.deadline` });
            const settled =
              capability === undefined
                ? true
                : yield* capabilities.settle(
                    capability.token,
                    reason,
                    Math.max(
                      0,
                      Math.min(
                        bounds.cleanup,
                        settlementDeadline - (yield* Clock.currentTimeMillis)
                      )
                    )
                  );
            const committedReply = capability?.mutation.value?.committedReply;
            if (committedReply !== undefined) {
              outcome = Exit.succeed(committedReply);
              break;
            }
            const uncertain = !settled || capability?.mutation.value?.uncertain === true;
            const keyRace = Option.isSome(failure) && MutationTransaction.isKeyRace(failure.value);
            if (mutationKey !== undefined && (uncertain || keyRace || timedOut)) {
              const resolved = yield* awaitUntil(
                mutations.lookup(binding, mutationKey),
                settlementDeadline
              );
              if (
                Option.isSome(resolved) &&
                Exit.isSuccess(resolved.value) &&
                resolved.value.value !== undefined
              ) {
                storedOutcome = resolved.value.value;
                outcome = Exit.succeed(storedOutcome.reply);
                break;
              }
              if (keyRace && Option.isSome(resolved) && Exit.isFailure(resolved.value)) {
                outcome = Exit.failCause(resolved.value.cause);
                break;
              }
            }
            if (uncertain)
              outcome = Exit.fail(
                new UnsettledInvocation({ correlationId: binding.correlationId })
              );
            else if (timedOut)
              outcome = Exit.fail(new HandlerTimeout({ correlationId: binding.correlationId }));
            else if (conflict) {
              if (
                attempts < bounds.mutationAttempts &&
                (yield* Clock.currentTimeMillis) < deadline
              ) {
                capability = undefined;
                // Retrying immediately makes the same hot-row writers collide again.
                // Jitter spreads retries without holding a connection or renewing the deadline.
                const backoff = mutationRetryDelay * 2 ** (attempts - 1);
                const wait = yield* Random.nextIntBetween(backoff, backoff * 4);
                yield* Effect.sleep(
                  Math.min(wait, Math.max(0, deadline - (yield* Clock.currentTimeMillis)))
                );
                continue;
              }
              if (parent === undefined)
                yield* WideEvents.enrich({ limitId: "tier2.mutation.attempts" });
              outcome = Exit.fail(
                new MutationTransaction.WriteConflict(
                  limitRefusal("tier2.mutation.attempts", bounds.mutationAttempts)
                )
              );
            } else if (Exit.isSuccess(raw)) outcome = Exit.succeed(raw.value);
            else if (Option.isSome(failure)) {
              const error = failure.value;
              if (isExecutionError(error)) {
                if (error.limits !== undefined) yield* WideEvents.enrich({ limits: error.limits });
                outcome = Exit.fail(
                  error.reason === "busy"
                    ? new ExecutorBusy({ ...error.limit, cause: error })
                    : new HandlerFailed({ correlationId: binding.correlationId, cause: error })
                );
              } else
                outcome = Exit.fail(
                  "code" in error ? error : new Runtime.SourceUnavailable({ cause: error })
                );
            } else
              outcome = Exit.fail(
                new HandlerFailed({
                  correlationId: binding.correlationId,
                  cause: Cause.squash(raw.cause)
                })
              );
            break;
          }
          if (storedOutcome !== undefined) {
            // Journal failure or a stuck driver cannot invalidate a proven commit.
            // Leave cleanup time for this invocation's own settlement.
            yield* awaitUntil(
              log.reconcileMutation({
                companyId: binding.companyId,
                invocationId: storedOutcome.invocationId
              }),
              deadline
            );
          }
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          const failure = Exit.isFailure(outcome)
            ? Cause.findErrorOption(outcome.cause)
            : Option.none();
          const outcomeCode =
            Option.isSome(failure) && "code" in failure.value ? failure.value.code : null;
          logs = capability?.logs ?? [];
          if (
            Option.isSome(failure) &&
            isHandlerFailed(failure.value) &&
            failure.value.cause !== undefined
          ) {
            const cause = failure.value.cause;
            const diagnostic = {
              message: "The host could not complete the handler.",
              details: { category: isExecutionError(cause) ? cause.reason : "host_failure" }
            };
            if (
              (capability?.counters.logBytes ?? 0) +
                encoder.encode(encodeJson(diagnostic)).byteLength <=
              bounds.log
            )
              logs.push(diagnostic);
          }
          if (
            // Quiet queries meter separately from attribution rows.
            options.dev !== undefined ||
            descriptor.kind !== "query" ||
            parent !== undefined ||
            Exit.isFailure(outcome) ||
            logs.length > 0 ||
            !outcome.value.ok
          ) {
            if (!logStarted && descriptor.kind === "query" && parent === undefined) {
              const admitted = yield* awaitUntil(log.begin(begin), settlementDeadline);
              if (Option.isNone(admitted))
                return yield* new UnsettledInvocation({ correlationId: binding.correlationId });
              yield* admitted.value.pipe(
                Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
              );
              logStarted = true;
            }
            if (logStarted)
              yield* finish(
                outcomeCode === "unknown_outcome"
                  ? "unknown_outcome"
                  : outcomeCode === "handler_timeout"
                    ? "handler_timeout"
                    : Exit.isFailure(outcome)
                      ? "failure"
                      : outcome.value.ok
                        ? "success"
                        : "handler_error",
                Exit.isSuccess(outcome) && !outcome.value.ok ? outcome.value.code : outcomeCode,
                settlementDeadline
              );
          } else if (platform !== undefined) {
            // Metering settlement belongs to the host, never to reply delivery.
            // Retrying an ambiguous write keeps the same run id.
            yield* platform
              .settleQuietQuery({
                runId: id,
                companyId: binding.companyId,
                patchId: binding.patchId,
                versionId: binding.versionId,
                handler: input.handler,
                startedAt,
                reRun: observation !== undefined,
                failures: 0,
                guestMs: Math.round(guestMs),
                dbMs: Math.round(meter.snapshot()),
                callbacks: capability?.counters.callbacks ?? 0,
                argsBytes,
                resultBytes
              })
              .pipe(Effect.forkIn(scope));
          }
          yield* WideEvents.add({
            callbacks: capability?.counters.callbacks ?? 0,
            attempts,
            argsBytes,
            resultBytes
          });
          for (const operation of capability?.counters.operations ?? [])
            yield* WideEvents.operation(operation);
          const peaks = [
            [`tier2.${descriptor.kind}.deadline`, bounds[descriptor.kind], elapsed],
            ...(descriptor.kind === "mutation"
              ? [["tier2.mutation.attempts", bounds.mutationAttempts, attempts] as const]
              : []),
            [
              `tier2.${descriptor.kind}.resultBytes`,
              bounds[`${descriptor.kind}Result`],
              resultBytes
            ],
            ["tier2.callbacks.count", bounds.callbacks, capability?.counters.callbacks ?? 0],
            [
              "tier2.callbacks.outstanding",
              bounds.outstanding,
              capability?.counters.peakOutstanding ?? 0
            ],
            ["tier2.callbacks.bytes", bounds.callbackBytes, capability?.counters.peakBytes ?? 0],
            ["tier2.log.bytes", bounds.log, capability?.counters.peakLogBytes ?? 0],
            ["tier2.callbacks.fileBytes", bounds.fileBytes, capability?.counters.peakFileBytes ?? 0]
          ] as const;
          yield* WideEvents.enrich({
            ...(parent === undefined
              ? {
                  outcome:
                    outcomeCode === "unknown_outcome"
                      ? ("unknown_outcome" as const)
                      : Exit.isFailure(outcome)
                        ? ("failure" as const)
                        : outcome.value.ok
                          ? ("success" as const)
                          : ("handler_error" as const),
                  ...(outcomeCode === null ? {} : { code: outcomeCode })
                }
              : {}),
            limits: peaks.map(([limitId, value, peak]) => ({
              limitId,
              value,
              peak,
              configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
            }))
          });
          if (parent === undefined) yield* WideEvents.enrich({ dbMs: meter.snapshot(), guestMs });
          return yield* outcome;
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              execution?.interruptUnsafe();
              const until = Math.min(
                settlementDeadline,
                (yield* Clock.currentTimeMillis) + bounds.cleanup
              );
              if (capability !== undefined) {
                yield* capabilities.end(capability.token, "process_killed");
                yield* capabilities.settle(
                  capability.token,
                  "process_killed",
                  Math.max(0, until - (yield* Clock.currentTimeMillis))
                );
              }
              if (logStarted)
                yield* finish("unknown_outcome", "unknown_outcome", until).pipe(Effect.ignore);
            })
          ),
          Effect.ensuring(
            Effect.sync(() => {
              execution?.interruptUnsafe();
              if (actionLimits === undefined) return;
              for (const [counts, entry] of [
                [companyActions, binding.companyId],
                [viewerActions, key]
              ] as const) {
                const count = (counts.get(entry) ?? 1) - 1;
                if (count === 0) counts.delete(entry);
                else counts.set(entry, count);
              }
            })
          )
        );
        const owner = yield* Effect.forkIn(
          Effect.interruptible(run).pipe(Effect.provideService(DatabaseMeter.current, meter)),
          scope
        );
        return yield* restore(Fiber.join(owner)).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              replyDelivered = false;
            })
          )
        );
      })
    );
    return yield* parent !== undefined && descriptor.kind === "mutation"
      ? capabilities
          .performEffect(parent.capability, invoke)
          .pipe(
            Effect.mapError((cause) =>
              isCapabilityRefused(cause) ? new Runtime.AccessDenied({ cause }) : cause
            )
          )
      : invoke;
  });
  return Invocation.of({ call });
});

export const make = Effect.fn("Invocation.makeProduction")(function* (options: {
  readonly callbackUrl: string;
}) {
  const operating = yield* OperatingLimits.OperatingLimits;
  const rollups = yield* QueryRollups.make;
  return yield* makeWithOptions(options, {
    actionLimits: (companyId) =>
      operating
        .getMany({
          companyId,
          limits: { company: "tier2.actions.company", viewer: "tier2.actions.viewer" }
        })
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))),
    settleQuietQuery: rollups.settle
  });
});

/** Dev skips both platform database services; all handler contract limits still apply. */
export const makeDev = (options: {
  readonly callbackUrl: string;
  readonly observe: (settlement: DevSettlement) => Effect.Effect<void>;
}) => makeWithOptions({ callbackUrl: options.callbackUrl, dev: { observe: options.observe } });

export const layer = (options: { readonly callbackUrl: string }) =>
  Layer.effect(Invocation, make(options));
