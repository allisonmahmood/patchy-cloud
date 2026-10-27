import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { RequireSession, Session } from "@patchy/auth";
import type { RuntimeMe } from "@patchy/api";
import * as Runtime from "./Runtime.js";
import * as PatchAccess from "./PatchAccess.js";

type Dependencies =
  | Session.Session
  | Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>;
export interface Identity {
  readonly companyId: string;
  readonly viewerId: string;
  readonly expiresAt: number;
  readonly identity: NonNullable<RuntimeMe>;
  readonly externalRecipient?: boolean;
  readonly externalAccess?: "read" | "write";
}

/** Production verifies cookies; dev supplies its two explicit mount identities.
 * @effect-expect-leaking HttpServerRequest
 */
export class StreamAdmission extends Context.Service<
  StreamAdmission,
  {
    readonly admit: Effect.Effect<
      Identity & { readonly recheck: Effect.Effect<Identity, Runtime.RuntimeError> },
      Runtime.RuntimeError,
      HttpServerRequest.HttpServerRequest
    >;
    readonly forPatch?: (
      target: PatchAccess.Target
    ) => Effect.Effect<
      Identity & { readonly recheck: Effect.Effect<Identity, Runtime.RuntimeError> },
      Runtime.RuntimeError,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("@patchy/runtime/StreamAdmission") {}

export const make: Effect.Effect<StreamAdmission["Service"], never, Dependencies> = Effect.gen(
  function* () {
    const session = yield* Session.Session;
    const viewerContext =
      yield* Effect.context<
        Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>
      >();
    const admit = (target?: PatchAccess.Target) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const browserRequest = new Request(new URL(request.url, session.publicBaseUrl), {
          method: request.method,
          headers: request.headers
        });
        const authenticate = session
          .authenticate(browserRequest)
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
        const signedIn = yield* authenticate;
        if (signedIn.status !== "signed-in") {
          if (
            signedIn.status === "handshake" ||
            signedIn.reason === "token-expired" ||
            signedIn.reason === "session-token-expired" ||
            signedIn.reason?.startsWith("session-token-expired-refresh-")
          )
            return yield* new Runtime.SessionRefreshRequired({});
          return yield* new Runtime.SessionExpired({});
        }
        if (signedIn.claims.exp * 1_000 <= (yield* Clock.currentTimeMillis))
          return yield* new Runtime.SessionRefreshRequired({});
        const resolve = PatchAccess.admit(signedIn.claims, target).pipe(
          Effect.provideContext(viewerContext),
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        const viewer = yield* resolve;
        if (viewer === null) return yield* new Runtime.AccessDenied({});
        return {
          companyId: viewer.viewer.company.id,
          viewerId: viewer.viewer.user.id,
          expiresAt: signedIn.claims.exp * 1_000,
          identity: viewer.viewer,
          externalRecipient: viewer.externalRecipient,
          ...(viewer.externalAccess === undefined ? {} : { externalAccess: viewer.externalAccess })
        };
      });
    const forPatch = (target?: PatchAccess.Target) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const identity = yield* admit(target);
        return {
          ...identity,
          recheck: admit(target).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request)
          )
        };
      });
    return StreamAdmission.of({
      admit: forPatch(),
      forPatch
    });
  }
);

export const layer = Layer.effect(StreamAdmission, make);
