import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RequireSession, Session } from "@patchy/auth";
import type { Limits, OperatingLimits } from "@patchy/limits";
import * as CompanyAdmission from "./CompanyAdmission.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as RuntimeStream from "./RuntimeStream.js";
import * as StreamAdmission from "./StreamAdmission.js";
import * as PatchAccess from "./PatchAccess.js";

type Dependencies =
  | CompanyAdmission.CompanyAdmission
  | LoadedVersions.LoadedVersions
  | Limits.Limits
  | OperatingLimits.OperatingLimits
  | RuntimeLog.RuntimeLog
  | StreamAdmission.StreamAdmission
  | Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>;

export const make = (
  handlers: Readonly<Record<string, Runtime.Handler>>
): Effect.Effect<Runtime.Runtime["Service"], never, Dependencies> =>
  Effect.gen(function* () {
    const log = yield* RuntimeLog.RuntimeLog;
    const session = yield* Session.Session;
    // The company's bucket, which Patchy MCP's door spends agents' calls from too.
    const companyAdmission = yield* CompanyAdmission.CompanyAdmission;
    const principalAdmission = yield* StreamAdmission.StreamAdmission;
    // The server provides the host's streams, so a call keeps its viewer's open documents
    // active; suites without streams have no documents to keep.
    const streams = yield* Effect.serviceOption(RuntimeStream.RuntimeStream);
    // Capture Auth's viewer resolver requirements, without importing its Companies dependencies.
    const viewerContext =
      yield* Effect.context<
        Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>
      >();
    const identity = (target?: PatchAccess.Target) =>
      Effect.gen(function* () {
        const admission = yield* RequireSession.admission.pipe(
          Effect.provideService(Session.Session, session),
          Effect.mapError((cause) => new Runtime.SessionExpired({ cause }))
        );
        if (HttpServerResponse.isHttpServerResponse(admission.result))
          return yield* new Runtime.SessionExpired({});
        const claims = admission.result;
        const resolveViewer = PatchAccess.admit(claims, target).pipe(
          Effect.provideContext(viewerContext),
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        const viewer = yield* resolveViewer;
        if (viewer === null) return yield* new Runtime.AccessDenied({});
        // Admission covers the JWT's remaining lifetime. After expiry, concurrent
        // callbacks share one backend result for this invocation, including failures.
        const activeAfterExpiry = yield* session.isActive(claims).pipe(
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })),
          Effect.cached
        );
        return {
          ...viewer,
          reauthorize: Effect.gen(function* () {
            if (
              (yield* Clock.currentTimeMillis) >= claims.exp * 1_000 &&
              !(yield* activeAfterExpiry)
            )
              return yield* new Runtime.SessionExpired({});
            const current = yield* resolveViewer;
            if (
              current === null ||
              current.viewer.user.id !== viewer.viewer.user.id ||
              current.viewer.company.id !== viewer.viewer.company.id ||
              current.externalAccess !== viewer.externalAccess
            )
              return yield* new Runtime.AccessDenied({});
            return current.viewer;
          })
        };
      });
    return yield* Runtime.make(handlers, {
      origin: new URL(session.publicBaseUrl).origin,
      identity: identity(),
      identityForPatch: identity,
      bootstrapIdentity: Effect.map(principalAdmission.admit, ({ identity, recheck }) => ({
        viewer: identity,
        reauthorize: Effect.map(recheck, (current) => current.identity)
      })),
      ...(Option.isSome(streams) ? { called: streams.value.called } : {}),
      admitCompany: companyAdmission.admit,
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

/** Runtime, and the company admission it spends, for the host's other doors to share. */
export const layer = (
  handlers: Readonly<Record<string, Runtime.Handler>>
): Layer.Layer<
  Runtime.Runtime | CompanyAdmission.CompanyAdmission,
  never,
  Exclude<Dependencies, CompanyAdmission.CompanyAdmission>
> => Layer.effect(Runtime.Runtime, make(handlers)).pipe(Layer.provideMerge(CompanyAdmission.layer));
