import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RequireSession, Session } from "@patchy/auth";
import { Limits } from "@patchy/limits";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";

type Dependencies =
  | LoadedVersions.LoadedVersions
  | Limits.Limits
  | RuntimeLog.RuntimeLog
  | Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>;

export const make = (
  handlers: Readonly<Record<string, Runtime.Handler>>
): Effect.Effect<Runtime.Runtime["Service"], Config.ConfigError, Dependencies> =>
  Effect.gen(function* () {
    const log = yield* RuntimeLog.RuntimeLog;
    const session = yield* Session.Session;
    // Capture Auth's viewer resolver requirements, without importing its Companies dependencies.
    const viewerContext =
      yield* Effect.context<
        Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>
      >();
    const identity = Effect.gen(function* () {
      const admission = yield* RequireSession.admission.pipe(
        Effect.provideService(Session.Session, session),
        Effect.mapError((cause) => new Runtime.SessionExpired({ cause }))
      );
      if (HttpServerResponse.isHttpServerResponse(admission.result))
        return yield* new Runtime.SessionExpired({});
      const viewer = yield* RequireSession.resolveViewer.pipe(
        Effect.provideContext(viewerContext),
        Effect.provideService(RequireSession.SignedIn, admission.result),
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
      );
      if (viewer === null || HttpServerResponse.isHttpServerResponse(viewer))
        return yield* new Runtime.AccessDenied({});
      return { user: viewer.user, company: viewer.company, admin: viewer.role === "admin" };
    });
    return yield* Runtime.make(handlers, {
      origin: new URL(session.publicBaseUrl).origin,
      identity,
      record: ({ input, operation, binding, deadlineMs }, run) =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          yield* log
            .begin({
              companyId: binding.companyId,
              patchId: binding.patchId,
              versionId: binding.versionId,
              userId: binding.identity!.user.id,
              credentialKind: "session",
              op: input.op,
              resource: operation.resource?.(input.args) ?? null,
              connectionId: operation.connectionId?.(input.args, binding) ?? null,
              ...(operation.sql === undefined ? {} : { sql: operation.sql(input.args) }),
              correlationId: binding.correlationId,
              deadlineMs
            })
            .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
          const result = yield* Effect.exit(run);
          // A lost client or process shutdown leaves the pending outcome unknown.
          if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) return result;
          const failure = Exit.isFailure(result)
            ? Cause.findErrorOption(result.cause)
            : Option.none<Runtime.RuntimeError>();
          yield* log
            .finish({
              correlationId: binding.correlationId,
              outcome: Exit.isSuccess(result) ? "success" : "failure",
              outcomeCode: Exit.isSuccess(result)
                ? null
                : Option.isSome(failure)
                  ? failure.value.code
                  : "source_unavailable",
              durationMs: (yield* Clock.currentTimeMillis) - started,
              rowCount: Exit.isSuccess(result) ? (operation.rowCount?.(result.value) ?? null) : null
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new Runtime.UnknownOutcome({ cause, correlationId: binding.correlationId })
              )
            );
          return result;
        })
    });
  });

export const layer = (
  handlers: Readonly<Record<string, Runtime.Handler>>
): Layer.Layer<Runtime.Runtime, Config.ConfigError, Dependencies> =>
  Layer.effect(Runtime.Runtime, make(handlers));
