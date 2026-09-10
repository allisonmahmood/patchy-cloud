import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RuntimePrincipal, WIRE_VERSION, type RuntimeEnvelope } from "@patchy/api";
import { RequireSession, Session } from "@patchy/auth";
import { newInternalId } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Binding from "./Binding.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as RuntimeLog from "./RuntimeLog.js";

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
export class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {
  ...diagnostics,
  maxBytes: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return `Runtime request exceeds ${this.maxBytes} bytes.`;
  }
}
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  ...diagnostics,
  retryAfterSeconds: Schema.Int
}) {
  readonly code = "rate_limited" as const;
  readonly status = 429;
  override get message() {
    return "Runtime request refused: rate_limited.";
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

export type RuntimeError =
  | InvalidRequest
  | AccessDenied
  | SessionExpired
  | PrincipalChanged
  | PublicUnavailable
  | ShellOutdated
  | TooLarge
  | RateLimited
  | SourceUnavailable
  | UnknownOutcome;

export interface Handler {
  readonly kind: "read" | "mutation" | "integration";
  readonly run: (args: unknown) => Effect.Effect<unknown, RuntimeError, Binding.Binding>;
}

/** Compile each operation's schemas once, retaining the handler's inferred input/output. */
export const handler = <
  Input extends Schema.Top & Schema.Codec<unknown, unknown>,
  Output extends Schema.Top & Schema.Codec<unknown, unknown>
>(
  definition: { readonly kind: Handler["kind"]; readonly input: Input; readonly output: Output },
  run: (args: Input["Type"]) => Effect.Effect<Output["Type"], RuntimeError, Binding.Binding>
): Handler => {
  const decode = Schema.decodeUnknownEffect(definition.input, { onExcessProperty: "error" });
  const encode = Schema.encodeEffect(definition.output);
  return {
    kind: definition.kind,
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

export const config = Config.all({
  callsPerMinute: Config.int("PATCHY_RUNTIME_CALLS_PER_MINUTE").pipe(Config.withDefault(300)),
  callBytes: Config.int("PATCHY_RUNTIME_CALL_BYTES").pipe(Config.withDefault(64 * 1024)),
  rowBytes: Config.int("PATCHY_RUNTIME_ROW_BYTES").pipe(Config.withDefault(1024 * 1024)),
  batchBytes: Config.int("PATCHY_RUNTIME_BATCH_BYTES").pipe(Config.withDefault(8 * 1024 * 1024)),
  postgresBytes: Config.int("PATCHY_RUNTIME_POSTGRES_BYTES").pipe(Config.withDefault(256 * 1024)),
  fileBytes: Config.int("PATCHY_RUNTIME_FILE_BYTES").pipe(Config.withDefault(20 * 1024 * 1024)),
  mutationDeadlineMs: Config.int("PATCHY_RUNTIME_MUTATION_DEADLINE_MS").pipe(
    Config.withDefault(30_000)
  ),
  integrationDeadlineMs: Config.int("PATCHY_RUNTIME_INTEGRATION_DEADLINE_MS").pipe(
    Config.withDefault(15_000)
  )
});

const decodePrincipal = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimePrincipal));
const decodeBodyPrincipal = Schema.decodeUnknownEffect(RuntimePrincipal);
export const decodeWire = Schema.decodeUnknownEffect(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))
);

export class Runtime extends Context.Service<
  Runtime,
  {
    readonly bodyLimit: (op: string) => number;
    readonly maxCallBytes: number;
    readonly fileBytes: number;
    readonly call: (
      input: typeof RuntimeEnvelope.Type
    ) => Effect.Effect<unknown, RuntimeError, HttpServerRequest.HttpServerRequest>;
  }
>()("@patchy/runtime/Runtime") {}

type Dependencies =
  | LoadedVersions.LoadedVersions
  | Limits.Limits
  | RuntimeLog.RuntimeLog
  | Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>;

export const make = (
  handlers: Readonly<Record<string, Handler>>
): Effect.Effect<Runtime["Service"], Config.ConfigError, Dependencies> =>
  Effect.gen(function* () {
    const versions = yield* LoadedVersions.LoadedVersions;
    const limits = yield* Limits.Limits;
    const log = yield* RuntimeLog.RuntimeLog;
    const session = yield* Session.Session;
    // Capture Auth's viewer resolver requirements, without importing its Companies dependencies.
    const viewerContext =
      yield* Effect.context<
        Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>
      >();
    const settings = yield* config;
    const origin = new URL(session.publicBaseUrl).origin;
    const bodyLimit = (op: string) =>
      op === "tables.insert" || op === "tables.update"
        ? settings.rowBytes + settings.callBytes
        : op === "tables.insertMany"
          ? settings.batchBytes + settings.callBytes
          : op.startsWith("postgres.")
            ? settings.postgresBytes
            : settings.callBytes;

    const call = Effect.fn("Runtime.call")(function* (input: typeof RuntimeEnvelope.Type) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== undefined) return yield* new AccessDenied({});
      const wire = yield* decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new InvalidRequest({ cause }))
      );
      if (request.headers["x-patchy-principal"] === undefined) return yield* new InvalidRequest({});
      if (wire !== input.wire) return yield* new InvalidRequest({});
      const operation = Object.hasOwn(handlers, input.op) ? handlers[input.op] : undefined;
      const mutating = operation?.kind === "mutation" || request.method === "PUT";
      if (
        (mutating && request.headers.origin !== origin) ||
        (request.method === "GET" && request.headers["sec-fetch-site"] !== "same-origin")
      )
        return yield* new AccessDenied({});
      const loaded = yield* versions
        .find(input.patchId, input.versionId)
        .pipe(Effect.mapError((cause) => new SourceUnavailable({ cause })));
      if (Option.isNone(loaded)) return yield* new AccessDenied({});
      const version = loaded.value;
      if (wire !== WIRE_VERSION || wire !== version.wireVersion)
        return yield* new ShellOutdated({});
      let identity: Binding.Binding["Service"]["identity"] = null;
      if (version.scope === "public") {
        if (input.op !== "me") return yield* new PublicUnavailable({});
      } else {
        const admission = yield* RequireSession.admission.pipe(
          Effect.provideService(Session.Session, session),
          Effect.mapError((cause) => new SessionExpired({ cause }))
        );
        if (HttpServerResponse.isHttpServerResponse(admission.result))
          return yield* new SessionExpired({});
        const viewer = yield* RequireSession.resolveViewer.pipe(
          Effect.provideContext(viewerContext),
          Effect.provideService(RequireSession.SignedIn, admission.result),
          Effect.mapError((cause) => new SourceUnavailable({ cause }))
        );
        if (
          viewer === null ||
          HttpServerResponse.isHttpServerResponse(viewer) ||
          viewer.company.id !== version.companyId
        )
          return yield* new AccessDenied({});
        const principal = yield* decodePrincipal(request.headers["x-patchy-principal"]).pipe(
          Effect.mapError((cause) => new InvalidRequest({ cause }))
        );
        if (request.method === "POST") {
          const bodyPrincipal = yield* decodeBodyPrincipal(input.principal).pipe(
            Effect.mapError((cause) => new InvalidRequest({ cause }))
          );
          if (principal?.userId !== bodyPrincipal?.userId) return yield* new InvalidRequest({});
        }
        if (principal === null ? input.op !== "me" : principal.userId !== viewer.user.id)
          return yield* new PrincipalChanged({});
        identity = { user: viewer.user, company: viewer.company, admin: viewer.role === "admin" };
      }
      const attempt = yield* limits.consume({
        key: `runtime:${identity?.user.id ?? `anonymous:${Option.getOrElse(request.remoteAddress, () => "")}`}:${version.patchId}`,
        limit: settings.callsPerMinute,
        window: "1 minute"
      });
      if (!attempt.allowed)
        return yield* new RateLimited({ retryAfterSeconds: attempt.retryAfterSeconds });
      if (operation === undefined) return yield* new InvalidRequest({});
      const binding = Binding.Binding.of({
        ...version,
        identity,
        principal: identity === null ? null : { userId: identity.user.id },
        correlationId: newInternalId("call")
      });
      const execute = Effect.suspend(() => operation.run(input.args)).pipe(
        Effect.provideService(Binding.Binding, binding)
      );
      if (operation.kind === "read") return yield* execute;
      const started = yield* Clock.currentTimeMillis;
      const deadlineMs =
        operation.kind === "mutation"
          ? settings.mutationDeadlineMs
          : settings.integrationDeadlineMs;
      yield* log
        .begin({
          companyId: binding.companyId,
          patchId: binding.patchId,
          versionId: binding.versionId,
          userId: identity!.user.id,
          credentialKind: "session",
          op: input.op,
          resource: null,
          connectionId: null,
          correlationId: binding.correlationId,
          deadlineMs
        })
        .pipe(Effect.mapError((cause) => new SourceUnavailable({ cause })));
      const result = yield* Effect.exit(execute);
      // Interruption includes a lost client or process shutdown: do not claim the write failed.
      if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
        return yield* Effect.failCause(result.cause);
      yield* log
        .finish({
          correlationId: binding.correlationId,
          outcome: Exit.isSuccess(result) ? "success" : "failure",
          durationMs: (yield* Clock.currentTimeMillis) - started,
          rowCount: null
        })
        .pipe(
          Effect.mapError(
            (cause) => new UnknownOutcome({ cause, correlationId: binding.correlationId })
          )
        );
      if (Exit.isFailure(result)) {
        const failure = Cause.findErrorOption(result.cause);
        return yield* Option.isSome(failure)
          ? Object.assign(failure.value, { correlationId: binding.correlationId })
          : new SourceUnavailable({ cause: result.cause, correlationId: binding.correlationId });
      }
      return result.value;
    });
    return Runtime.of({
      call,
      bodyLimit,
      maxCallBytes: Math.max(settings.batchBytes + settings.callBytes, settings.postgresBytes),
      fileBytes: settings.fileBytes
    });
  });

export const layer = (
  handlers: Readonly<Record<string, Handler>>
): Layer.Layer<Runtime, Config.ConfigError, Dependencies> => Layer.effect(Runtime, make(handlers));
