// @effect-diagnostics nodeBuiltinImport:off -- Buffer counts UTF-8 bytes without allocating another encoded body.
import { Buffer } from "node:buffer";
import { limitRefusal, type HandlerKind, type RuntimeFailure } from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import { newInternalId } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Binding from "./Binding.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";

const strict = { onExcessProperty: "error" } as const;
const decodeCallback = Schema.decodeUnknownEffect(GuestProtocol.Callback, strict);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const Log = Schema.Struct({ message: Schema.String, details: Schema.optionalKey(Schema.Json) });
const decodeLog = Schema.decodeUnknownEffect(Log, strict);
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
  "shared.stat": true
};
const readFile: Readonly<Record<string, true>> = { "files.list": true, "files.stat": true };
const actionFile: Readonly<Record<string, true>> = {
  "files.get": true,
  "files.put": true,
  "files.delete": true
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
  (kind === "action" && (Object.hasOwn(actionFile, op) || Object.hasOwn(connections, op)));
const viewerAuthority = (op: string) =>
  Object.hasOwn(shared, op) || Object.hasOwn(members, op) || Object.hasOwn(connections, op);
const refused = (
  code: "access_denied" | "invalid_request" | "source_unavailable",
  error: string
): RuntimeFailure => ({ ok: false, source: "patchy", code, error });
const bounded = (
  id:
    | "tier2.callbacks.count"
    | "tier2.callbacks.bytes"
    | "tier2.callbacks.fileBytes"
    | "tier2.log.bytes",
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
    count: ContractLimits.get("tier2.callbacks.count"),
    bytes: ContractLimits.get("tier2.callbacks.bytes"),
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
    const remember = (reply: GuestProtocol.CallbackReply): GuestProtocol.CallbackReply => {
      if (!reply.ok && reply.source === "patchy") {
        // Beyond the count cap every reply is the same refusal. Retain it only once.
        if (capability.refusals.length <= limits.count) capability.refusals.push(reply);
      }
      return reply;
    };
    if (!transportCharged) {
      capability.counters.callbacks++;
      if (capability.counters.callbacks > limits.count)
        return remember(bounded("tier2.callbacks.count", limits.count));
    }
    const decoded = yield* Effect.result(decodeCallback(input));
    if (decoded._tag === "Failure")
      return remember(refused("invalid_request", "Malformed callback."));
    const request = decoded.success;
    const requestBytes = transportCharged
      ? 0
      : Buffer.byteLength(encodeJson({ op: request.op, args: request.args })) +
        (request.body?.bytes.byteLength ?? 0);
    if (request.body !== undefined && request.body.bytes.byteLength > limits.fileBytes)
      return remember(bounded("tier2.callbacks.fileBytes", limits.fileBytes));
    if (capability.tree.bytes + requestBytes > limits.bytes)
      return remember(bounded("tier2.callbacks.bytes", limits.bytes));
    capability.tree.bytes += requestBytes;
    if (!allowed(capability.kind, request.op))
      return remember(
        refused("access_denied", "The handler kind cannot use this callback operation.")
      );
    const operation = Object.hasOwn(handlers, request.op) ? handlers[request.op] : undefined;
    if (request.op !== "log" && operation === undefined)
      return remember(refused("invalid_request", "Unknown callback operation."));
    if (capability.kind === "query" && operation?.transport !== undefined)
      return remember(refused("access_denied", "Queries cannot transfer file bytes."));
    const run = Effect.gen(function* (): Effect.fn.Return<
      GuestProtocol.CallbackReply,
      Runtime.RuntimeError | InvocationCapabilities.CapabilityRefused
    > {
      if (request.op === "log") {
        if (request.body !== undefined)
          return refused("invalid_request", "Log callbacks require JSON.");
        const line = yield* decodeLog(request.args).pipe(
          Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
        );
        const bytes = Buffer.byteLength(encodeJson(line));
        if (capability.counters.logBytes + bytes > limits.logBytes)
          return bounded("tier2.log.bytes", limits.logBytes);
        capability.counters.logBytes += bytes;
        capability.logs.push(line);
        return { ok: true, value: null };
      }
      const handler = operation!;
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
          if (request.body === undefined) return yield* new Runtime.InvalidRequest({});
          const args = { ...request.args, contentType: request.body.contentType };
          yield* handler
            .run(args, request.body.bytes)
            .pipe(Effect.provideService(Binding.Binding, binding));
          return { ok: true, value: null };
        }
        if (request.body !== undefined) return yield* new Runtime.InvalidRequest({});
        if (handler.transport === "bytes-get") {
          const body = yield* handler
            .run(request.args)
            .pipe(Effect.provideService(Binding.Binding, binding));
          if (body.bytes.byteLength > limits.fileBytes)
            return bounded("tier2.callbacks.fileBytes", limits.fileBytes);
          return { ok: true, body };
        }
        const value = yield* handler
          .run(request.args)
          .pipe(Effect.provideService(Binding.Binding, binding));
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
      const result = yield* Effect.exit(withDeadline);
      if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
        return yield* Effect.failCause(result.cause);
      const failure = Exit.isFailure(result) ? Cause.findErrorOption(result.cause) : Option.none();
      const reply = Exit.isSuccess(result) ? result.value : undefined;
      yield* log
        .finish({
          correlationId: binding.correlationId,
          outcome: reply?.ok === true ? "success" : "failure",
          outcomeCode:
            reply !== undefined && !reply.ok
              ? reply.code
              : Option.isSome(failure)
                ? isCapabilityRefused(failure.value)
                  ? "access_denied"
                  : failure.value.code
                : reply?.ok
                  ? null
                  : "source_unavailable",
          durationMs: (yield* Clock.currentTimeMillis) - now,
          rowCount: reply?.ok && "value" in reply ? (handler.rowCount?.(reply.value) ?? null) : null
        })
        .pipe(
          Effect.mapError(
            (cause) => new Runtime.UnknownOutcome({ cause, correlationId: binding.correlationId })
          )
        );
      if (Exit.isFailure(result)) {
        if (Option.isSome(failure) && !isCapabilityRefused(failure.value))
          return { ...Runtime.toFailure(failure.value), correlationId: binding.correlationId };
        return yield* Effect.failCause(result.cause);
      }
      return result.value;
    });
    const result = yield* Effect.exit(capabilities.execute(capability, run));
    let reply: GuestProtocol.CallbackReply;
    if (Exit.isSuccess(result)) reply = result.value;
    else {
      const error = Cause.findErrorOption(result.cause);
      if (Option.isSome(error))
        reply = isCapabilityRefused(error.value)
          ? error.value.failure
          : Runtime.toFailure(error.value);
      else {
        const live = yield* Effect.result(capabilities.resolve(token, attempt));
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
    if (capability.tree.bytes + responseBytes > limits.bytes)
      return remember(bounded("tier2.callbacks.bytes", limits.bytes));
    capability.tree.bytes += responseBytes;
    return remember(reply);
  });
  return CallbackGateway.of({ callback });
});

export const layer = (handlers: Readonly<Record<string, Runtime.Handler>>) =>
  Layer.effect(CallbackGateway, make(handlers));
