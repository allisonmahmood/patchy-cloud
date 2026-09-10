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
import { RuntimeCode, RuntimePrincipal, WIRE_VERSION, type RuntimeEnvelope } from "@patchy/api";
import { RequireSession, Session } from "@patchy/auth";
import { newInternalId } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Binding from "./Binding.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as RuntimeLog from "./RuntimeLog.js";

export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
  code: RuntimeCode,
  maxBytes: Schema.optionalKey(Schema.Int),
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  correlationId: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return this.maxBytes === undefined
      ? `Runtime request refused: ${this.code}.`
      : `Runtime request exceeds ${this.maxBytes} bytes.`;
  }
}

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
        Effect.mapError((cause) => new RuntimeError({ code: "invalid_request", cause })),
        Effect.flatMap(run),
        Effect.flatMap((value) =>
          encode(value).pipe(
            Effect.mapError((cause) => new RuntimeError({ code: "source_unavailable", cause }))
          )
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
const decodeWire = Schema.decodeUnknownEffect(
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
      if (request.headers.authorization !== undefined)
        return yield* new RuntimeError({ code: "access_denied" });
      const wire = yield* decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new RuntimeError({ code: "invalid_request", cause }))
      );
      if (request.headers["x-patchy-principal"] === undefined)
        return yield* new RuntimeError({ code: "invalid_request" });
      if (wire !== input.wire) return yield* new RuntimeError({ code: "invalid_request" });
      const operation = Object.hasOwn(handlers, input.op) ? handlers[input.op] : undefined;
      const mutating = operation?.kind === "mutation" || request.method === "PUT";
      if (
        (mutating && request.headers.origin !== origin) ||
        (request.method === "GET" && request.headers["sec-fetch-site"] !== "same-origin")
      )
        return yield* new RuntimeError({ code: "access_denied" });
      const loaded = yield* versions
        .find(input.patchId, input.versionId)
        .pipe(Effect.mapError((cause) => new RuntimeError({ code: "source_unavailable", cause })));
      if (Option.isNone(loaded)) return yield* new RuntimeError({ code: "access_denied" });
      const version = loaded.value;
      if (wire !== WIRE_VERSION || wire !== version.wireVersion)
        return yield* new RuntimeError({ code: "shell_outdated" });
      let identity: Binding.Binding["Service"]["identity"] = null;
      if (version.scope === "public") {
        if (input.op !== "me") return yield* new RuntimeError({ code: "not_available_on_public" });
      } else {
        const admission = yield* RequireSession.admission.pipe(
          Effect.provideService(Session.Session, session),
          Effect.mapError((cause) => new RuntimeError({ code: "session_expired", cause }))
        );
        if (HttpServerResponse.isHttpServerResponse(admission.result))
          return yield* new RuntimeError({ code: "session_expired" });
        const viewer = yield* RequireSession.resolveViewer.pipe(
          Effect.provideContext(viewerContext),
          Effect.provideService(RequireSession.SignedIn, admission.result),
          Effect.mapError((cause) => new RuntimeError({ code: "source_unavailable", cause }))
        );
        if (
          viewer === null ||
          HttpServerResponse.isHttpServerResponse(viewer) ||
          viewer.company.id !== version.companyId
        )
          return yield* new RuntimeError({ code: "access_denied" });
        const principal = yield* decodePrincipal(request.headers["x-patchy-principal"]).pipe(
          Effect.mapError((cause) => new RuntimeError({ code: "invalid_request", cause }))
        );
        if (request.method === "POST") {
          const bodyPrincipal = yield* decodeBodyPrincipal(input.principal).pipe(
            Effect.mapError((cause) => new RuntimeError({ code: "invalid_request", cause }))
          );
          if (principal?.userId !== bodyPrincipal?.userId)
            return yield* new RuntimeError({ code: "invalid_request" });
        }
        if (principal === null ? input.op !== "me" : principal.userId !== viewer.user.id)
          return yield* new RuntimeError({ code: "principal_changed" });
        identity = { user: viewer.user, company: viewer.company, admin: viewer.role === "admin" };
      }
      const attempt = yield* limits.consume({
        key: `runtime:${identity?.user.id ?? `anonymous:${Option.getOrElse(request.remoteAddress, () => "")}`}:${version.patchId}`,
        limit: settings.callsPerMinute,
        window: "1 minute"
      });
      if (!attempt.allowed)
        return yield* new RuntimeError({
          code: "rate_limited",
          retryAfterSeconds: attempt.retryAfterSeconds
        });
      if (operation === undefined) return yield* new RuntimeError({ code: "invalid_request" });
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
        .pipe(
          Effect.mapError(
            (cause) =>
              new RuntimeError({
                code: "source_unavailable",
                cause,
                correlationId: binding.correlationId
              })
          )
        );
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
            (cause) =>
              new RuntimeError({
                code: "unknown_outcome",
                cause,
                correlationId: binding.correlationId
              })
          )
        );
      if (Exit.isFailure(result)) {
        const failure = Cause.findErrorOption(result.cause);
        return yield* new RuntimeError({
          code: Option.isSome(failure) ? failure.value.code : "source_unavailable",
          cause: result.cause,
          correlationId: binding.correlationId
        });
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
