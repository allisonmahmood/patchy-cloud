import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RequireSession, Session } from "@patchy/auth";
import type { RuntimeMe } from "@patchy/api";
import { Companies } from "@patchy/companies";
import * as GuestAccess from "./GuestAccess.js";
import type * as LoadedVersions from "./LoadedVersions.js";
import * as PatchViewer from "./PatchViewer.js";
import * as Runtime from "./Runtime.js";

type Dependencies =
  | Session.Session
  | Companies.Companies
  | GuestAccess.GuestAccess
  | Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>;
type LoadedVersion = LoadedVersions.LoadedVersion & { readonly patchTier: number };
export interface Identity {
  readonly companyId: string;
  readonly viewerId: string;
  readonly expiresAt: number;
  readonly identity: NonNullable<RuntimeMe>;
}

/** Production verifies cookies; dev supplies its two explicit mount identities.
 * @effect-expect-leaking HttpServerRequest
 */
export class StreamAdmission extends Context.Service<
  StreamAdmission,
  {
    readonly admit: (
      loaded: LoadedVersion
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
    const patchContext = yield* Effect.context<Companies.Companies | GuestAccess.GuestAccess>();
    const viewerContext =
      yield* Effect.context<
        Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>
      >();
    const admit = (loaded: LoadedVersion) =>
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
        const resolve = RequireSession.resolveViewer.pipe(
          Effect.provideContext(viewerContext),
          Effect.provideService(RequireSession.SignedIn, signedIn.claims),
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        const viewer = yield* resolve;
        if (viewer === null || HttpServerResponse.isHttpServerResponse(viewer))
          return yield* new Runtime.AccessDenied({});
        const patchViewer = yield* PatchViewer.resolve(loaded, viewer).pipe(
          Effect.provideContext(patchContext)
        );
        return {
          companyId: patchViewer.company.id,
          viewerId: viewer.user.id,
          expiresAt: signedIn.claims.exp * 1_000,
          identity: patchViewer
        };
      });
    return StreamAdmission.of({
      admit: (loaded) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const identity = yield* admit(loaded);
          return {
            ...identity,
            recheck: admit(loaded).pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request)
            )
          };
        })
    });
  }
);

export const layer = Layer.effect(StreamAdmission, make);
