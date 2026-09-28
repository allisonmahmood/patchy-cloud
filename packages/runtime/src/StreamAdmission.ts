import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RequireSession, Session } from "@patchy/auth";
import * as Runtime from "./Runtime.js";

type Dependencies =
  | Session.Session
  | Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>;
type Admission = Effect.Effect<
  {
    readonly companyId: string;
    readonly viewerId: string;
    readonly expiresAt: number;
  },
  Runtime.RuntimeError,
  HttpServerRequest.HttpServerRequest
>;

/** Every open verifies the cookie and current viewer, then retains only the token deadline. */
export const make: Effect.Effect<{ readonly admit: Admission }, never, Dependencies> = Effect.gen(
  function* () {
    const session = yield* Session.Session;
    const viewerContext =
      yield* Effect.context<
        Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>
      >();
    const admit = Effect.gen(function* () {
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
      return {
        companyId: viewer.company.id,
        viewerId: viewer.user.id,
        expiresAt: signedIn.claims.exp * 1_000
      };
    });
    return { admit };
  }
);
