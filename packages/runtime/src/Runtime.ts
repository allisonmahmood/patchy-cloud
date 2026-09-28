import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import {
  RuntimePrincipal,
  runtimeBodyLimit,
  runtimeBodyLimitId,
  WIRE_VERSION,
  runtimeOperations,
  type RuntimeCode,
  type RuntimeBodyLimitId,
  type RuntimeEnvelope,
  type FileBody
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { newInternalId } from "@patchy/core";
import { ContractLimits, Limits } from "@patchy/limits";
import { registry, type LimitScope } from "@patchy/limits/registry";
import * as Binding from "./Binding.js";
import * as LoadedVersions from "./LoadedVersions.js";

const textEncoder = new TextEncoder();

const diagnostics = {
  cause: Schema.optionalKey(Schema.Defect()),
  correlationId: Schema.optionalKey(Schema.String)
};

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  diagnostics
) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  override get message() {
    return "Runtime request refused: invalid_request.";
  }
}
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", diagnostics) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return "Runtime request refused: access_denied.";
  }
}
export class SessionExpired extends Schema.TaggedError<SessionExpired>()(
  "SessionExpired",
  diagnostics
) {
  readonly code = "session_expired" as const;
  readonly status = 401;
  override get message() {
    return "Runtime request refused: session_expired.";
  }
}
export class PrincipalChanged extends Schema.TaggedError<PrincipalChanged>()(
  "PrincipalChanged",
  diagnostics
) {
  readonly code = "principal_changed" as const;
  readonly status = 409;
  override get message() {
    return "Runtime request refused: principal_changed.";
  }
}
export class PublicUnavailable extends Schema.TaggedError<PublicUnavailable>()(
  "PublicUnavailable",
  diagnostics
) {
  readonly code = "not_available_on_public" as const;
  readonly status = 403;
  override get message() {
    return "Runtime request refused: not_available_on_public.";
  }
}
export class ShellOutdated extends Schema.TaggedError<ShellOutdated>()(
  "ShellOutdated",
  diagnostics
) {
  readonly code = "shell_outdated" as const;
  readonly status = 409;
  override get message() {
    return "Runtime request refused: shell_outdated.";
  }
}
export class Draining extends Schema.TaggedError<Draining>()("Draining", {}) {
  readonly code = "busy" as const;
  readonly status = 503;
  readonly retryAfterSeconds = 1;
  override get message() {
    return "The host is draining.";
  }
}
export class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {
  ...diagnostics,
  maxBytes: Schema.Int,
  limitId: Schema.Literals([
    "runtime.call.bytes",
    "runtime.row.bytes",
    "runtime.batch.bytes",
    "runtime.postgres.bytes",
    "tier2.args.bytes",
    "runtime.result.bytes",
    "runtime.file.bytes"
  ])
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return this.maxBytes;
  }
  override get message() {
    return `Runtime request exceeds ${this.maxBytes} bytes.`;
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  ...diagnostics,
  deadlineMs: Schema.Int,
  limitId: Schema.Literals(["runtime.mutation.deadline", "integration.deadline"])
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return this.deadlineMs;
  }
  override get message() {
    return `The call exceeded its ${this.deadlineMs} ms service deadline.`;
  }
}
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  ...diagnostics,
  retryAfterSeconds: Schema.Int,
  value: Schema.Int,
  limitId: Schema.Literals(["runtime.calls.perMinute", "rate.trackedKeys"])
}) {
  readonly code = "rate_limited" as const;
  readonly status = 429;
  get scope() {
    return registry[this.limitId].scope;
  }
  override get message() {
    return "Runtime request refused: rate_limited.";
  }
}
export class LimitExceeded extends Schema.TaggedError<LimitExceeded>()("LimitExceeded", {
  ...diagnostics,
  retryAfterSeconds: Schema.Int,
  value: Schema.Number,
  limitId: Schema.Literal("company.admission.rate")
}) {
  readonly code = "limit_exceeded" as const;
  readonly status = 429;
  get scope() {
    return registry[this.limitId].scope;
  }
  override get message() {
    return "Runtime request refused: limit_exceeded.";
  }
}
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "SourceUnavailable",
  {
    cause: Schema.Defect(),
    correlationId: Schema.optionalKey(Schema.String)
  }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Runtime request refused: source_unavailable.";
  }
}
export class UnknownOutcome extends Schema.TaggedError<UnknownOutcome>()("UnknownOutcome", {
  cause: Schema.Defect(),
  correlationId: Schema.String
}) {
  readonly code = "unknown_outcome" as const;
  readonly status = 503;
  override get message() {
    return "Runtime request refused: unknown_outcome.";
  }
}

/** Capabilities supply domain errors without introducing a reverse package dependency. */
export interface OperationError {
  readonly code: RuntimeCode;
  readonly status: number;
  readonly message: string;
  readonly correlationId?: string;
  readonly retryAfterSeconds?: number;
  readonly limitId?: string;
  readonly scope?: LimitScope;
  readonly value?: number;
  readonly details?: Readonly<Record<string, typeof Schema.Json.Type>>;
}

export type RuntimeError =
  | InvalidRequest
  | AccessDenied
  | SessionExpired
  | PrincipalChanged
  | PublicUnavailable
  | ShellOutdated
  | TooLarge
  | Timeout
  | RateLimited
  | LimitExceeded
  | SourceUnavailable
  | UnknownOutcome
  | OperationError;

interface HandlerMetadata {
  readonly kind: "read" | "mutation" | "integration";
  readonly resource?: (args: unknown) => string | null;
  readonly rowCount?: (value: unknown) => number | null;
  readonly connectionId?: (args: unknown, binding: Binding.Binding["Service"]) => string | null;
  readonly sql?: (args: unknown) => string | undefined;
}

export interface JsonHandler extends HandlerMetadata {
  readonly transport?: never;
  readonly run: (args: unknown) => Effect.Effect<unknown, RuntimeError, Binding.Binding>;
}

export interface BytesPutHandler extends HandlerMetadata {
  readonly transport: "bytes-put";
  readonly kind: "mutation";
  readonly run: (
    args: unknown,
    bytes: Uint8Array
  ) => Effect.Effect<null, RuntimeError, Binding.Binding>;
}

export interface BytesGetHandler extends HandlerMetadata {
  readonly transport: "bytes-get";
  readonly kind: "read";
  readonly run: (args: unknown) => Effect.Effect<FileBody, RuntimeError, Binding.Binding>;
}

export type Handler = JsonHandler | BytesPutHandler | BytesGetHandler;

/** Compile each operation's schemas once, retaining the handler's inferred input/output. */
export const handler = <
  Input extends Schema.Top & Schema.Codec<unknown, unknown>,
  Output extends Schema.Top & Schema.Codec<unknown, unknown>
>(
  definition: {
    readonly kind: Handler["kind"];
    readonly input: Input;
    readonly output: Output;
    readonly resource?: Handler["resource"];
    readonly rowCount?: Handler["rowCount"];
    readonly connectionId?: Handler["connectionId"];
    readonly sql?: Handler["sql"];
  },
  run: (args: Input["Type"]) => Effect.Effect<Output["Type"], RuntimeError, Binding.Binding>
): JsonHandler => {
  const decode = Schema.decodeUnknownEffect(definition.input, { onExcessProperty: "error" });
  const encode = Schema.encodeEffect(definition.output);
  return {
    kind: definition.kind,
    ...(definition.resource === undefined ? {} : { resource: definition.resource }),
    ...(definition.rowCount === undefined ? {} : { rowCount: definition.rowCount }),
    ...(definition.connectionId === undefined ? {} : { connectionId: definition.connectionId }),
    ...(definition.sql === undefined ? {} : { sql: definition.sql }),
    run: (args) =>
      decode(args).pipe(
        Effect.mapError((cause) => new InvalidRequest({ cause })),
        Effect.flatMap(run),
        Effect.flatMap((value) =>
          encode(value).pipe(Effect.mapError((cause) => new SourceUnavailable({ cause })))
        )
      )
  };
};

export const byteLimits = {
  rowBytes: ContractLimits.get("runtime.row.bytes"),
  batchBytes: ContractLimits.get("runtime.batch.bytes"),
  resultBytes: ContractLimits.get("runtime.result.bytes"),
  fileBytes: ContractLimits.get("runtime.file.bytes")
};

export const config = Effect.all({
  callsPerMinute: ContractLimits.get("runtime.calls.perMinute"),
  callBytes: ContractLimits.get("runtime.call.bytes"),
  rowBytes: byteLimits.rowBytes,
  batchBytes: byteLimits.batchBytes,
  postgresBytes: ContractLimits.get("runtime.postgres.bytes"),
  serverArgsBytes: ContractLimits.get("tier2.args.bytes"),
  fileBytes: byteLimits.fileBytes,
  mutationDeadlineMs: ContractLimits.get("runtime.mutation.deadline"),
  integrationDeadlineMs: ContractLimits.get("integration.deadline")
});

const decodePrincipal = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimePrincipal), {
  onExcessProperty: "error"
});
const decodeBodyPrincipal = Schema.decodeUnknownEffect(RuntimePrincipal, {
  onExcessProperty: "error"
});
export const decodeWire = Schema.decodeUnknownEffect(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))
);
const encodeServerArgs = Schema.encodeUnknownEffect(
  Schema.fromJsonString(runtimeOperations["server.call"].request.fields.args.fields.args)
);

/**
 * Admission consumes the current browser request, never a request captured at startup.
 * @effect-expect-leaking HttpServerRequest
 */
export class Runtime extends Context.Service<
  Runtime,
  {
    readonly bodyLimit: (op: string) => number;
    readonly drain: Effect.Effect<void>;
    readonly maxCallBytes: number;
    readonly maxCallLimitId: RuntimeBodyLimitId;
    readonly fileBytes: number;
    readonly call: (
      input: typeof RuntimeEnvelope.Type,
      byteLength?: number
    ) => Effect.Effect<unknown, RuntimeError, HttpServerRequest.HttpServerRequest>;
    readonly putFile: (
      input: typeof RuntimeEnvelope.Type,
      readBytes: Effect.Effect<Uint8Array, RuntimeError, HttpServerRequest.HttpServerRequest>
    ) => Effect.Effect<null, RuntimeError, HttpServerRequest.HttpServerRequest>;
    readonly getFile: (
      input: typeof RuntimeEnvelope.Type
    ) => Effect.Effect<FileBody, RuntimeError, HttpServerRequest.HttpServerRequest>;
  }
>()("@patchy/runtime/Runtime") {}

export interface Execution {
  readonly input: typeof RuntimeEnvelope.Type;
  readonly operation: Handler;
  readonly binding: Binding.Binding["Service"];
  readonly deadlineMs: number;
}

/** Environment adapters choose identity and recording; admission and execution stay shared. */
export interface Options {
  readonly origin: string;
  readonly identity: Effect.Effect<
    NonNullable<Binding.Binding["Service"]["identity"]>,
    RuntimeError,
    HttpServerRequest.HttpServerRequest
  >;
  /** Production operating admission, once per incoming operation, never inside a handler. */
  readonly admitCompany?: (companyId: string) => Effect.Effect<void, RuntimeError>;
  readonly record?: <A>(
    execution: Execution,
    run: Effect.Effect<A, RuntimeError, HttpServerRequest.HttpServerRequest>
  ) => Effect.Effect<Exit.Exit<A, RuntimeError>, RuntimeError, HttpServerRequest.HttpServerRequest>;
}

type Dependencies = LoadedVersions.LoadedVersions | Limits.Limits;

export const make = (
  handlers: Readonly<Record<string, Handler>>,
  options: Options
): Effect.Effect<Runtime["Service"], never, Dependencies> =>
  Effect.gen(function* () {
    const versions = yield* LoadedVersions.LoadedVersions;
    const limits = yield* Limits.Limits;
    const settings = yield* config;
    const origin = options.origin;
    let draining = false;
    const bodyLimit = (op: string) => runtimeBodyLimit(op, settings);
    const maxCallBytes = Math.max(
      settings.rowBytes + settings.callBytes,
      settings.batchBytes + settings.callBytes,
      settings.postgresBytes,
      settings.serverArgsBytes + settings.callBytes
    );
    const maxCallLimitId =
      maxCallBytes === settings.batchBytes + settings.callBytes
        ? "runtime.batch.bytes"
        : maxCallBytes === settings.rowBytes + settings.callBytes
          ? "runtime.row.bytes"
          : maxCallBytes === settings.serverArgsBytes + settings.callBytes
            ? "tier2.args.bytes"
            : "runtime.postgres.bytes";

    const dispatch = <A>(
      input: typeof RuntimeEnvelope.Type,
      run: (
        operation: Handler
      ) => Effect.Effect<A, RuntimeError, Binding.Binding | HttpServerRequest.HttpServerRequest>,
      byteLength?: number
    ) =>
      Effect.gen(function* () {
        if (draining) return yield* new Draining();
        const operation = Object.hasOwn(handlers, input.op) ? handlers[input.op] : undefined;
        if (operation !== undefined || Object.hasOwn(runtimeOperations, input.op))
          yield* WideEvents.operation(input.op);
        const integration = operation?.kind === "integration";
        const boundedOp = operation !== undefined || input.op === "server.call" ? input.op : "";
        const maxBytes = bodyLimit(boundedOp);
        const limitId = runtimeBodyLimitId(boundedOp);
        // Only integration refusals need trusted attribution before their size check.
        // Other operations, including unknown names, reject before loading a session or version.
        if (!integration && byteLength !== undefined && byteLength > maxBytes)
          return yield* new TooLarge({ maxBytes, limitId });
        if (
          input.op === "server.call" &&
          input.args !== null &&
          typeof input.args === "object" &&
          "args" in input.args
        ) {
          const argsJson = yield* encodeServerArgs(input.args.args).pipe(
            Effect.mapError((cause) => new InvalidRequest({ cause }))
          );
          if (textEncoder.encode(argsJson).byteLength > settings.serverArgsBytes)
            return yield* new TooLarge({
              maxBytes: settings.serverArgsBytes,
              limitId: "tier2.args.bytes"
            });
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.authorization !== undefined) return yield* new AccessDenied({});
        const requestAdmission = yield* Effect.exit(
          Effect.gen(function* () {
            const wire = yield* decodeWire(request.headers["x-patchy-wire"]).pipe(
              Effect.mapError((cause) => new InvalidRequest({ cause }))
            );
            if (request.headers["x-patchy-principal"] === undefined || wire !== input.wire)
              return yield* new InvalidRequest({});
            // A constrained SELECT can invoke functions: integrations require the same
            // exact Origin as mutations, never a Sec-Fetch-Site fallback.
            if (
              ((operation?.kind === "mutation" || integration || request.method === "PUT") &&
                request.headers.origin !== origin) ||
              (request.method === "GET" && request.headers["sec-fetch-site"] !== "same-origin")
            )
              return yield* new AccessDenied({});
            return wire;
          })
        );
        if (!integration && Exit.isFailure(requestAdmission))
          return yield* Effect.failCause(requestAdmission.cause);
        const loaded = yield* versions
          .find(input.patchId, input.versionId)
          .pipe(Effect.mapError((cause) => new SourceUnavailable({ cause })));
        if (Option.isNone(loaded) || loaded.value.revoked) return yield* new AccessDenied({});
        const version = loaded.value;
        yield* WideEvents.enrich({
          companyId: version.companyId,
          patchId: version.patchId,
          versionId: version.versionId,
          tier: version.manifest.tier
        });
        if (
          !integration &&
          Exit.isSuccess(requestAdmission) &&
          (requestAdmission.value !== WIRE_VERSION ||
            requestAdmission.value !== version.wireVersion)
        )
          return yield* new ShellOutdated({});
        let identity: Binding.Binding["Service"]["identity"] = null;
        if (version.scope === "public") {
          if (input.op !== "me") return yield* new PublicUnavailable({});
        } else {
          identity = yield* options.identity;
          yield* WideEvents.enrich({ viewerId: identity.user.id });
          if (identity.company.id !== version.companyId) return yield* new AccessDenied({});
        }
        const binding = Binding.Binding.of({
          ...version,
          identity,
          principal: identity === null ? null : { userId: identity.user.id },
          correlationId: newInternalId("call")
        });
        const admit = Effect.gen(function* () {
          if (integration && byteLength !== undefined && byteLength > maxBytes)
            return yield* new TooLarge({ maxBytes, limitId });
          if (Exit.isFailure(requestAdmission))
            return yield* Effect.failCause(requestAdmission.cause);
          if (
            requestAdmission.value !== WIRE_VERSION ||
            requestAdmission.value !== version.wireVersion
          )
            return yield* new ShellOutdated({});
          if (identity !== null) {
            const principal = yield* decodePrincipal(request.headers["x-patchy-principal"]).pipe(
              Effect.mapError((cause) => new InvalidRequest({ cause }))
            );
            if (request.method === "POST") {
              const bodyPrincipal = yield* decodeBodyPrincipal(input.principal).pipe(
                Effect.mapError((cause) => new InvalidRequest({ cause }))
              );
              if (principal?.userId !== bodyPrincipal?.userId) return yield* new InvalidRequest({});
            }
            if (principal === null ? input.op !== "me" : principal.userId !== identity.user.id)
              return yield* new PrincipalChanged({});
          }
          const attempt = yield* limits.consume({
            key: `runtime:${identity?.user.id ?? `anonymous:${Option.getOrElse(request.remoteAddress, () => "")}`}:${version.patchId}`,
            limit: settings.callsPerMinute,
            window: "1 minute"
          });
          if (!attempt.allowed)
            return yield* new RateLimited({
              retryAfterSeconds: attempt.retryAfterSeconds,
              limitId:
                attempt.reason === "capacity" ? "rate.trackedKeys" : "runtime.calls.perMinute",
              value:
                attempt.reason === "capacity" ? Limits.MAX_TRACKED_KEYS : settings.callsPerMinute
            });
          if (version.scope !== "public" && options.admitCompany !== undefined)
            yield* options.admitCompany(version.companyId);
          if (draining) return yield* new Draining();
        });
        // For integrations, log the attempt before admission or input decoding can
        // refuse it. Attribution comes only from the live viewer and loaded version.
        if (!integration) yield* admit;
        if (operation === undefined) return yield* new InvalidRequest({});
        const execute = Effect.gen(function* () {
          if (integration) yield* admit;
          return yield* run(operation);
        }).pipe(Effect.provideService(Binding.Binding, binding));
        if (operation.kind === "read") return yield* execute;
        const deadlineMs =
          operation.kind === "mutation"
            ? settings.mutationDeadlineMs
            : settings.integrationDeadlineMs;
        // The logged deadline is the enforced one: past it the call fails with `timeout`.
        const runWithDeadline = execute.pipe(
          Effect.timeoutOrElse({
            duration: deadlineMs,
            orElse: () =>
              Effect.fail(
                new Timeout({
                  deadlineMs,
                  limitId:
                    operation.kind === "mutation"
                      ? "runtime.mutation.deadline"
                      : "integration.deadline"
                })
              )
          })
        );
        const result = yield* options.record === undefined
          ? Effect.exit(runWithDeadline)
          : options.record({ input, operation, binding, deadlineMs }, runWithDeadline);
        // Interruption includes a lost client or process shutdown: do not claim the write failed.
        if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
          return yield* Effect.failCause(result.cause);
        const failure = Exit.isFailure(result)
          ? Cause.findErrorOption(result.cause)
          : Option.none<RuntimeError>();
        if (Exit.isFailure(result)) {
          if (Option.isSome(failure)) {
            if (options.record !== undefined)
              Object.assign(failure.value, { correlationId: binding.correlationId });
            return yield* Effect.fail(failure.value);
          }
          return yield* new SourceUnavailable({
            cause: result.cause,
            ...(options.record === undefined ? {} : { correlationId: binding.correlationId })
          });
        }
        return result.value;
      });
    return Runtime.of({
      drain: Effect.sync(() => {
        draining = true;
      }),
      call: (input, byteLength) =>
        dispatch(
          input,
          (operation) =>
            operation.transport === undefined
              ? operation.run(input.args)
              : Effect.fail(new InvalidRequest({})),
          byteLength
        ),
      putFile: (input, readBytes) =>
        dispatch(input, (operation) =>
          operation.transport === "bytes-put"
            ? readBytes.pipe(Effect.flatMap((bytes) => operation.run(input.args, bytes)))
            : Effect.fail(new InvalidRequest({}))
        ),
      getFile: (input) =>
        dispatch(input, (operation) =>
          operation.transport === "bytes-get"
            ? operation.run(input.args)
            : Effect.fail(new InvalidRequest({}))
        ),
      bodyLimit,
      // Cover every runtimeBodyLimit branch, including explicitly injected test bounds.
      maxCallBytes,
      maxCallLimitId,
      fileBytes: settings.fileBytes
    });
  });
