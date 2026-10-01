// @effect-diagnostics nodeBuiltinImport:off -- Buffer counts UTF-8 bytes without allocating another encoded body.
import { Buffer } from "node:buffer";
import { FilePutUpload, limitRefusal, type HandlerKind, type RuntimeFailure } from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import { newInternalId } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
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
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";

export class CallbackJournalTimeout extends Schema.TaggedError<CallbackJournalTimeout>()(
  "CallbackJournalTimeout",
  {
    correlationId: Schema.String,
    deadline: Schema.Number
  }
) {
  readonly code = "unknown_outcome" as const;
  readonly status = 503;
  override get message() {
    return "The callback outcome could not be recorded before cleanup ended.";
  }
}

const strict = { onExcessProperty: "error" } as const;
const decodeCallback = Schema.decodeUnknownEffect(GuestProtocol.Callback, strict);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const Log = Schema.Struct({ message: Schema.String, details: Schema.optionalKey(Schema.Json) });
const decodeLog = Schema.decodeUnknownEffect(Log, strict);
const decodeAdoption = Schema.decodeUnknownEffect(FilePutUpload, strict);
const isCapabilityRefused = Schema.is(InvocationCapabilities.CapabilityRefused);
const readTable: Readonly<Record<string, true>> = {
  "tables.get": true,
  "tables.getMany": true,
  "tables.list": true
};
const writeTable: Readonly<Record<string, true>> = {
  "tables.insert": true,
  "tables.insertMany": true,
  "tables.update": true,
  "tables.delete": true
};
const members: Readonly<Record<string, true>> = {
  "members.list": true,
  "members.search": true,
  "members.get": true,
  "members.getMany": true
};
const shared: Readonly<Record<string, true>> = {
  "shared.get": true,
  "shared.getMany": true,
  "shared.list": true,
  "shared.files.list": true,
  "shared.files.stat": true
};
const readFile: Readonly<Record<string, true>> = { "files.list": true, "files.stat": true };
const actionFile: Readonly<Record<string, true>> = {
  "files.get": true,
  "files.put": true,
  "files.delete": true,
  "files.inspectUpload": true
};
const connections: Readonly<Record<string, true>> = {
  "postgres.list": true,
  "postgres.get": true,
  "postgres.getMany": true,
  "postgres.query": true
};
const allowed = (kind: HandlerKind, op: string) =>
  op === "log" ||
  Object.hasOwn(readTable, op) ||
  Object.hasOwn(members, op) ||
  (kind !== "query" && Object.hasOwn(writeTable, op)) ||
  (kind !== "mutation" && (Object.hasOwn(shared, op) || Object.hasOwn(readFile, op))) ||
  (kind === "action" &&
    (op === "server.call" ||
      op === "shared.files.get" ||
      Object.hasOwn(actionFile, op) ||
      Object.hasOwn(connections, op)));
const viewerAuthority = (op: string) =>
  Object.hasOwn(shared, op) ||
  op === "shared.files.get" ||
  Object.hasOwn(members, op) ||
  Object.hasOwn(connections, op);
const refused = (
  code: "access_denied" | "invalid_request" | "source_unavailable",
  error: string
): RuntimeFailure => ({ ok: false, source: "patchy", code, error });
const bounded = (
  id: "tier2.callbacks.fileBytes" | "tier2.log.bytes",
  value: number
): RuntimeFailure => ({
  ok: false,
  source: "patchy",
  error: `Invocation callback exceeds ${id}.`,
  ...limitRefusal(id, value)
});

export class CallbackGateway extends Context.Service<
  CallbackGateway,
  {
    readonly callback: (
      token: string,
      attempt: InvocationCapabilities.AttemptIdentity,
      input: GuestProtocol.Callback,
      /** The private listener already charged this request's count and bytes. */
      transportCharged?: boolean
    ) => Effect.Effect<GuestProtocol.CallbackReply>;
  }
>()("@patchy/runtime/CallbackGateway") {}

export const make = Effect.fn("CallbackGateway.make")(function* (
  handlers: Readonly<Record<string, Runtime.Handler>>
) {
  const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
  const log = yield* RuntimeLog.RuntimeLog;
  const limits = yield* Effect.all({
    cleanup: ContractLimits.get("tier2.settlement.cleanup"),
    fileBytes: ContractLimits.get("tier2.callbacks.fileBytes"),
    logBytes: ContractLimits.get("tier2.log.bytes"),
    mutationDeadline: ContractLimits.get("runtime.mutation.deadline"),
    integrationDeadline: ContractLimits.get("integration.deadline")
  });
  const callback = Effect.fn("CallbackGateway.callback")(function* (
    token: string,
    attempt: InvocationCapabilities.AttemptIdentity,
    input: GuestProtocol.Callback,
    transportCharged = false
  ): Effect.fn.Return<GuestProtocol.CallbackReply> {
    const resolved = yield* Effect.result(capabilities.resolve(token, attempt));
    if (resolved._tag === "Failure") return resolved.failure.failure;
    const capability = resolved.success;
    const remember = (
      reply: GuestProtocol.CallbackReply,
      status: number
    ): GuestProtocol.CallbackReply =>
      !reply.ok && reply.source === "patchy"
        ? capabilities.rememberRefusal(capability, reply, status)
        : reply;
    if (!transportCharged) {
      const refusal = capabilities.chargeCallback(capability);
      if (refusal !== undefined) return refusal;
    }
    const decoded = yield* Effect.result(decodeCallback(input));
    if (decoded._tag === "Failure")
      return remember(refused("invalid_request", "Malformed callback."), 400);
    const request = decoded.success;
    // Record the canonical owner before kind, live-viewer or resource access checks.
    if (capability.kind === "query" && capability.onDependency !== undefined) {
      const { binding } = capability;
      if (request.op.startsWith("tables.") && typeof request.args.table === "string")
        capability.onDependency(`table:${binding.patchId}:${request.args.table}`);
      else if (request.op.startsWith("files.") && typeof request.args.store === "string")
        capability.onDependency(`store:${binding.patchId}:${request.args.store}`);
      else if (Object.hasOwn(members, request.op))
        capability.onDependency(`members:${binding.companyId}`);
      else if (request.op.startsWith("shared.") && typeof request.args.alias === "string") {
        const declaration = Object.hasOwn(binding.manifest.uses, request.args.alias)
          ? binding.manifest.uses[request.args.alias]
          : undefined;
        if (declaration?.kind === "sharedTable") {
          capability.onDependency(`table:${declaration.patchId}:${declaration.table}`);
          capability.onDependency(`patch:${declaration.patchId}`);
        } else if (declaration?.kind === "sharedStore") {
          capability.onDependency(`store:${declaration.patchId}:${declaration.store}`);
          capability.onDependency(`patch:${declaration.patchId}`);
        }
      }
    }
    if (request.op === "log" || request.op === "server.call" || Object.hasOwn(handlers, request.op))
      capability.counters.operations.add(request.op);
    if (request.body !== undefined)
      capability.counters.peakFileBytes = Math.max(
        capability.counters.peakFileBytes,
        request.body.bytes.byteLength
      );
    const requestBytes = transportCharged
      ? 0
      : Buffer.byteLength(encodeJson({ op: request.op, args: request.args })) +
        (request.body?.bytes.byteLength ?? 0);
    if (request.body !== undefined && request.body.bytes.byteLength > limits.fileBytes)
      return remember(bounded("tier2.callbacks.fileBytes", limits.fileBytes), 413);
    const bytesRefusal = capabilities.chargeBytes(capability, requestBytes);
    if (bytesRefusal !== undefined) return bytesRefusal;
    if (!allowed(capability.kind, request.op))
      return remember(
        refused("access_denied", "The handler kind cannot use this callback operation."),
        403
      );
    const operation = Object.hasOwn(handlers, request.op) ? handlers[request.op] : undefined;
    if (request.op !== "log" && request.op !== "server.call" && operation === undefined)
      return remember(refused("invalid_request", "Unknown callback operation."), 400);
    if (capability.kind === "query" && operation?.transport !== undefined)
      return remember(refused("access_denied", "Queries cannot transfer file bytes."), 403);
    const run = Effect.gen(function* (): Effect.fn.Return<
      GuestProtocol.CallbackReply,
      Runtime.RuntimeError | InvocationCapabilities.CapabilityRefused
    > {
      if (request.op === "server.call") {
        if (request.body !== undefined || capability.run === undefined)
          return remember(refused("access_denied", "Nested handlers are unavailable."), 403);
        return yield* capability.run(request.args);
      }
      if (request.op === "log") {
        if (request.body !== undefined)
          return remember(refused("invalid_request", "Log callbacks require JSON."), 400);
        const line = yield* decodeLog(request.args).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        const bytes = Buffer.byteLength(encodeJson(line));
        capability.counters.peakLogBytes = Math.max(
          capability.counters.peakLogBytes,
          capability.counters.logBytes + bytes
        );
        if (capability.counters.logBytes + bytes > limits.logBytes)
          return remember(bounded("tier2.log.bytes", limits.logBytes), 429);
        capability.counters.logBytes += bytes;
        capability.logs.push(line);
        return { ok: true, value: null };
      }
      const handler = operation!;
      const perform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        handler.kind === "read" || capability.kind === "mutation"
          ? effect
          : capabilities.performEffect(capability, effect);
      const now = yield* Clock.currentTimeMillis;
      const deadlineMs = Math.max(
        0,
        Math.min(
          capability.attempt.deadline - now,
          handler.kind === "integration"
            ? limits.integrationDeadline
            : handler.kind === "mutation"
              ? limits.mutationDeadline
              : Infinity
        )
      );
      const effectivePrincipal = viewerAuthority(request.op)
        ? capability.binding.identity!.user.id
        : "patch";
      let binding = Binding.Binding.of({
        ...capability.binding,
        effectivePrincipal,
        invocationId: attempt.invocationId,
        correlationId: newInternalId("call")
      });
      const execute = Effect.gen(function* (): Effect.fn.Return<
        GuestProtocol.CallbackReply,
        Runtime.RuntimeError | InvocationCapabilities.CapabilityRefused
      > {
        if (viewerAuthority(request.op)) {
          const identity = yield* capability.reauthorize;
          if (
            identity.company.id !== binding.companyId ||
            identity.user.id !== capability.binding.identity?.user.id
          )
            return yield* new Runtime.AccessDenied({});
          binding = { ...binding, identity };
        }
        // Reauthorization may have waited past return or deadline.
        yield* capabilities.resolve(token, attempt);
        if (handler.transport === "bytes-put") {
          const args =
            request.body === undefined
              ? request.op === "files.put"
                ? yield* decodeAdoption(request.args).pipe(
                    Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
                  )
                : yield* new Runtime.InvalidRequest({})
              : { ...request.args, contentType: request.body.contentType };
          const value = yield* perform(
            handler
              .run(args, request.body?.bytes)
              .pipe(Effect.provideService(Binding.Binding, binding))
          );
          return {
            ok: true,
            value: yield* decodeJson(value).pipe(
              Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
            )
          };
        }
        if (request.body !== undefined) return yield* new Runtime.InvalidRequest({});
        if (handler.transport === "bytes-get") {
          const body = yield* perform(
            handler.run(request.args).pipe(Effect.provideService(Binding.Binding, binding))
          );
          capability.counters.peakFileBytes = Math.max(
            capability.counters.peakFileBytes,
            body.bytes.byteLength
          );
          if (body.bytes.byteLength > limits.fileBytes)
            return remember(bounded("tier2.callbacks.fileBytes", limits.fileBytes), 413);
          return { ok: true, body };
        }
        const value = yield* perform(
          handler.run(request.args).pipe(Effect.provideService(Binding.Binding, binding))
        );
        return {
          ok: true,
          value: yield* decodeJson(value).pipe(
            Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
          )
        };
      });
      const withDeadline =
        handler.kind === "read"
          ? execute
          : execute.pipe(
              Effect.timeoutOrElse({
                duration: deadlineMs,
                orElse: () =>
                  Effect.fail(
                    new Runtime.Timeout({
                      deadlineMs,
                      limitId:
                        handler.kind === "integration"
                          ? "integration.deadline"
                          : "runtime.mutation.deadline"
                    })
                  )
              })
            );
      if (handler.kind === "read") return yield* withDeadline;
      yield* log
        .begin({
          companyId: binding.companyId,
          patchId: binding.patchId,
          versionId: binding.versionId,
          userId: effectivePrincipal === "patch" ? null : effectivePrincipal,
          effectivePrincipal,
          invocationId: attempt.invocationId,
          credentialKind: "session",
          op: request.op,
          resource: handler.resource?.(request.args) ?? null,
          connectionId: handler.connectionId?.(request.args, binding) ?? null,
          ...(handler.sql === undefined ? {} : { sql: handler.sql(request.args) }),
          correlationId: binding.correlationId,
          deadlineMs
        })
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(restore(withDeadline));
          const failure = Exit.isFailure(result)
            ? Cause.findErrorOption(result.cause)
            : Option.none();
          const reply = Exit.isSuccess(result) ? result.value : undefined;
          if (Exit.isFailure(result)) capability.mutation.value?.abort(result.cause);
          const uncertain =
            Exit.isFailure(result) &&
            (Cause.hasInterrupts(result.cause) ||
              Cause.hasDies(result.cause) ||
              (Option.isSome(failure) &&
                !isCapabilityRefused(failure.value) &&
                (failure.value.code === "unknown_outcome" || failure.value.code === "timeout")));
          const cleanupDeadline =
            Math.min(now + deadlineMs, capability.attempt.deadline) + limits.cleanup;
          const remaining = Math.max(0, cleanupDeadline - (yield* Clock.currentTimeMillis));
          if (remaining === 0)
            return yield* new CallbackJournalTimeout({
              correlationId: binding.correlationId,
              deadline: cleanupDeadline
            });
          const journal = yield* log
            .finish({
              correlationId: binding.correlationId,
              outcome: uncertain ? "unknown" : reply?.ok === true ? "success" : "failure",
              outcomeCode: uncertain
                ? "unknown_outcome"
                : reply !== undefined && !reply.ok
                  ? reply.code
                  : Option.isSome(failure)
                    ? isCapabilityRefused(failure.value)
                      ? "access_denied"
                      : failure.value.code
                    : reply?.ok
                      ? null
                      : "source_unavailable",
              durationMs: (yield* Clock.currentTimeMillis) - now,
              rowCount:
                reply?.ok && "value" in reply ? (handler.rowCount?.(reply.value) ?? null) : null
            })
            .pipe(Effect.interruptible, Effect.forkDetach);
          // Await only the fiber handle: a stuck SQL finalizer must not extend cleanup.
          const recorded = yield* Fiber.await(journal).pipe(Effect.timeoutOption(remaining));
          if (Option.isNone(recorded)) {
            journal.interruptUnsafe();
            return yield* new CallbackJournalTimeout({
              correlationId: binding.correlationId,
              deadline: cleanupDeadline
            });
          }
          yield* recorded.value.pipe(
            Effect.mapError(
              (cause) => new Runtime.UnknownOutcome({ cause, correlationId: binding.correlationId })
            )
          );
          if (Exit.isFailure(result)) {
            if (Option.isSome(failure) && !isCapabilityRefused(failure.value))
              return remember(
                { ...Runtime.toFailure(failure.value), correlationId: binding.correlationId },
                failure.value.status
              );
            return yield* Effect.failCause(result.cause);
          }
          return result.value;
        })
      );
    });
    const operationRun =
      capability.kind === "query" && request.op !== "log"
        ? capability.snapshot.value === undefined
          ? Effect.fail(new Runtime.InvocationUnavailable())
          : capability.snapshot.value.run(run)
        : capability.kind === "mutation"
          ? capability.mutation.value === undefined
            ? Effect.fail(new Runtime.InvocationUnavailable())
            : capability.mutation.value
                .run(run)
                .pipe(
                  Effect.mapError((cause) =>
                    isCapabilityRefused(cause) || "code" in cause
                      ? cause
                      : new Runtime.SourceUnavailable({ cause })
                  )
                )
          : run;
    const result = yield* Effect.exit(capabilities.execute(capability, operationRun));
    let reply: GuestProtocol.CallbackReply;
    let status = 200;
    if (Exit.isSuccess(result)) reply = result.value;
    else {
      const error = Cause.findErrorOption(result.cause);
      if (Option.isSome(error)) {
        status = isCapabilityRefused(error.value) ? 403 : error.value.status;
        reply = isCapabilityRefused(error.value)
          ? error.value.failure
          : Runtime.toFailure(error.value);
      } else {
        const live = yield* Effect.result(capabilities.resolve(token, attempt));
        status = live._tag === "Failure" ? 403 : 503;
        reply =
          live._tag === "Failure"
            ? live.failure.failure
            : refused("source_unavailable", "The callback could not complete.");
      }
    }
    const responseBytes =
      reply.ok && "body" in reply
        ? reply.body.bytes.byteLength
        : Buffer.byteLength(encodeJson(reply));
    const responseRefusal = capabilities.chargeBytes(capability, responseBytes);
    if (responseRefusal !== undefined) return responseRefusal;
    return remember(reply, status);
  });
  return CallbackGateway.of({ callback });
});

export const layer = (handlers: Readonly<Record<string, Runtime.Handler>>) =>
  Layer.effect(CallbackGateway, make(handlers));
