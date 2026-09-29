import {
  canonicalArgs,
  handlerArgsSchema,
  handlerValueSchema,
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
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Binding from "./Binding.js";
import * as Executor from "./Executor.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as Runtime from "./Runtime.js";
import * as ServerBundles from "./ServerBundles.js";

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
  failure: RuntimeFailure
}) {
  readonly status = 400;
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
interface CompiledHandler {
  readonly args: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly result: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
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

export class Invocation extends Context.Service<
  Invocation,
  {
    readonly call: (
      args: unknown,
      binding: Binding.Binding["Service"],
      reauthorize: Effect.Effect<NonNullable<RuntimeMe>, Runtime.RuntimeError>
    ) => Effect.Effect<ServerCallReply, Runtime.RuntimeError>;
  }
>()("@patchy/runtime/Invocation") {}

/** Its scope, not the HTTP request, owns admitted work and deadline settlement. */
export const make = Effect.fn("Invocation.make")(function* (options: {
  readonly callbackUrl: string;
}) {
  const scope = yield* Effect.scope;
  const executor = yield* Executor.Executor;
  const bundles = yield* ServerBundles.ServerBundles;
  const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
  const log = yield* InvocationLog.InvocationLog;
  const operating = yield* OperatingLimits.OperatingLimits;
  const bounds = yield* Effect.all({
    query: ContractLimits.get("tier2.query.deadline"),
    mutation: ContractLimits.get("tier2.mutation.deadline"),
    action: ContractLimits.get("tier2.action.deadline"),
    cleanup: ContractLimits.get("tier2.settlement.cleanup"),
    log: ContractLimits.get("tier2.log.bytes"),
    args: ContractLimits.get("tier2.args.bytes"),
    queryResult: ContractLimits.get("tier2.query.resultBytes"),
    mutationResult: ContractLimits.get("tier2.mutation.resultBytes"),
    actionResult: ContractLimits.get("tier2.action.resultBytes")
  });
  const codecs = new WeakMap<typeof Manifest.Type, Map<string, CompiledHandler>>();
  const companyActions = new Map<string, number>();
  const viewerActions = new Map<string, number>();

  const call = Effect.fn("Invocation.call")(function* (
    args: unknown,
    binding: Binding.Binding["Service"],
    reauthorize: Effect.Effect<NonNullable<RuntimeMe>, Runtime.RuntimeError>
  ) {
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
    if (argsBytes > bounds.args)
      return yield* new Runtime.TooLarge({ maxBytes: bounds.args, limitId: "tier2.args.bytes" });
    const key = canonicalArgs([binding.companyId, binding.patchId, viewer.user.id]);
    const actionLimits =
      descriptor.kind === "action"
        ? yield* operating
            .getMany({
              companyId: binding.companyId,
              limits: {
                company: "tier2.actions.company",
                viewer: "tier2.actions.viewer"
              }
            })
            .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })))
        : undefined;
    const resultCodec = codec.result;
    return yield* Effect.uninterruptibleMask((restore) =>
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
            if (used >= limit)
              return yield* new InvocationBusy({ limitId, value: limit, scope: limitScope });
          }
          companyActions.set(binding.companyId, (companyActions.get(binding.companyId) ?? 0) + 1);
          viewerActions.set(key, (viewerActions.get(key) ?? 0) + 1);
        }
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = startedAt + bounds[descriptor.kind];
        const id = newInternalId("inv");
        const attemptId = newInternalId("attempt");
        let replyDelivered = true;
        let capability: InvocationCapabilities.Capability | undefined;
        let guestMs = 0;
        let resultBytes = 0;
        const begin = {
          id,
          companyId: binding.companyId,
          patchId: binding.patchId,
          versionId: binding.versionId,
          handler: input.handler,
          kind: descriptor.kind,
          initiatingViewerId: viewer.user.id,
          parentId: null,
          correlationId: binding.correlationId,
          startedAt,
          deadline,
          argsBytes
        };
        const run = Effect.gen(function* () {
          const dispatch = Effect.gen(function* () {
            const bundle = yield* bundles.load(binding);
            if (
              bundle.companyId !== binding.companyId ||
              bundle.patchId !== binding.patchId ||
              bundle.versionId !== binding.versionId
            )
              return yield* new HandlerFailed({ correlationId: binding.correlationId });
            const bound = yield* executor.bind(bundle);
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
            if ((yield* Clock.currentTimeMillis) >= deadline)
              return yield* new HandlerTimeout({ correlationId: binding.correlationId });
            capability = yield* capabilities.issue({
              binding: { ...binding, invocationId: id, effectivePrincipal: "patch" },
              attempt: {
                invocationId: id,
                attemptId,
                processGeneration: bound.processGeneration,
                deadline
              },
              kind: descriptor.kind,
              reauthorize
            });
            return yield* executor.invoke({
              wire: GuestProtocol.wireVersion,
              binding: bound.binding,
              ...capability.attempt,
              handler: input.handler,
              args: input.args,
              viewer,
              callback: { url: options.callbackUrl, capability: capability.token }
            });
          });
          if (descriptor.kind !== "query")
            yield* log
              .begin(begin)
              .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
          const execution = yield* Effect.forkIn(dispatch, scope);
          const raced = yield* Fiber.await(execution).pipe(
            Effect.map((exit) => ({ type: "completed" as const, exit })),
            Effect.raceFirst(
              Effect.sleep(Math.max(0, deadline - (yield* Clock.currentTimeMillis))).pipe(
                Effect.as({ type: "deadline" as const })
              )
            )
          );
          const timedOut =
            raced.type === "deadline" || (yield* Clock.currentTimeMillis) >= deadline;
          let reason: InvocationCapabilities.EndReason = timedOut ? "deadline" : "returned";
          if (raced.type === "completed" && Exit.isFailure(raced.exit)) {
            const error = Cause.findErrorOption(raced.exit.cause);
            if (
              Option.isSome(error) &&
              isExecutionError(error.value) &&
              error.value.reason === "process_killed"
            )
              reason = "process_killed";
          }
          if (timedOut) execution.interruptUnsafe();
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
                      deadline + bounds.cleanup - (yield* Clock.currentTimeMillis)
                    )
                  )
                );
          const outcome = yield* Effect.exit(
            Effect.gen(function* () {
              if (!settled)
                return yield* new UnsettledInvocation({ correlationId: binding.correlationId });
              if (timedOut)
                return yield* new HandlerTimeout({ correlationId: binding.correlationId });
              if (raced.type !== "completed")
                return yield* new HandlerTimeout({ correlationId: binding.correlationId });
              if (Exit.isFailure(raced.exit)) {
                const error = Cause.findErrorOption(raced.exit.cause);
                if (Option.isNone(error))
                  return yield* new HandlerFailed({
                    correlationId: binding.correlationId,
                    cause: Cause.squash(raced.exit.cause)
                  });
                const failure = error.value;
                if (isExecutionError(failure)) {
                  if (failure.reason === "busy")
                    return yield* new ExecutorBusy({ ...failure.limit, cause: failure });
                  return yield* new HandlerFailed({
                    correlationId: binding.correlationId,
                    cause: failure
                  });
                }
                return yield* Effect.fail(failure);
              }
              const observed = yield* decodeReply(raced.exit.value).pipe(
                Effect.mapError(
                  (cause) => new HandlerFailed({ correlationId: binding.correlationId, cause })
                )
              );
              guestMs = observed.guestMs;
              if (observed.outcome !== "returned")
                return yield* new HandlerFailed({ correlationId: binding.correlationId });
              const reply = observed.reply;
              if (!reply.ok) {
                if (reply.source === "handler") {
                  if (!descriptor.errors?.includes(reply.code))
                    return yield* new HandlerFailed({ correlationId: binding.correlationId });
                } else {
                  const trusted = capability?.refusals.find(
                    (failure) => canonicalArgs(failure) === canonicalArgs(reply)
                  );
                  if (trusted !== undefined)
                    return yield* new CallbackRefusal({ failure: trusted });
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
              return reply.ok ? { ok: true as const, value } : reply;
            })
          );
          const failure = Exit.isFailure(outcome)
            ? Cause.findErrorOption(outcome.cause)
            : Option.none();
          const outcomeCode =
            Option.isSome(failure) && "code" in failure.value ? failure.value.code : null;
          const logs = capability?.logs ?? [];
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
            descriptor.kind !== "query" ||
            Exit.isFailure(outcome) ||
            logs.length > 0 ||
            !outcome.value.ok
          ) {
            if (descriptor.kind === "query")
              yield* log
                .begin(begin)
                .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
            const settledAt = yield* Clock.currentTimeMillis;
            yield* log
              .finish({
                id,
                outcome:
                  outcomeCode === "unknown_outcome"
                    ? "unknown_outcome"
                    : outcomeCode === "handler_timeout"
                      ? "handler_timeout"
                      : Exit.isFailure(outcome)
                        ? "failure"
                        : outcome.value.ok
                          ? "success"
                          : "handler_error",
                outcomeCode:
                  Exit.isSuccess(outcome) && !outcome.value.ok ? outcome.value.code : outcomeCode,
                settledAt,
                durationMs: settledAt - startedAt,
                guestMs,
                dbMs: 0,
                callbacks: capability?.counters.callbacks ?? 0,
                resultBytes,
                attempts: 1,
                logLines: logs,
                replyDelivered
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new Runtime.UnknownOutcome({ cause, correlationId: binding.correlationId })
                )
              );
          }
          return yield* outcome;
        }).pipe(
          Effect.onInterrupt(() =>
            capability === undefined
              ? Effect.void
              : capabilities.end(capability.token, "process_killed")
          ),
          Effect.ensuring(
            Effect.sync(() => {
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
        const owner = yield* Effect.forkIn(Effect.interruptible(run), scope);
        return yield* restore(Fiber.join(owner)).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              replyDelivered = false;
            })
          )
        );
      })
    );
  });
  return Invocation.of({ call });
});

export const layer = (options: { readonly callbackUrl: string }) =>
  Layer.effect(Invocation, make(options));
