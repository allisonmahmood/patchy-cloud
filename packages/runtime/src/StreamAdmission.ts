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
    readonly check: Effect.Effect<"live" | "reauthenticate", Runtime.RuntimeError>;
  },
  Runtime.RuntimeError,
  HttpServerRequest.HttpServerRequest
>;

/** Cookie admission is repeated on every open; the check never retains a database connection. */
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
      if (signedIn.status !== "signed-in") return yield* new Runtime.SessionExpired({});
      const resolve = RequireSession.resolveViewer.pipe(
        Effect.provideContext(viewerContext),
        Effect.provideService(RequireSession.SignedIn, signedIn.claims),
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
      );
      const viewer = yield* resolve;
      if (viewer === null || HttpServerResponse.isHttpServerResponse(viewer))
        return yield* new Runtime.AccessDenied({});
      const check = Effect.gen(function* () {
        const current = yield* authenticate;
        // A stream has an immutable cookie snapshot. An expired short-lived JWT must
        // reconnect with the browser's refreshed cookie, not stop a healthy session.
        if (current.status === "handshake") return "reauthenticate" as const;
        if (current.status === "signed-out") {
          if (
            current.reason === "token-expired" ||
            current.reason === "session-token-expired" ||
            current.reason?.startsWith("session-token-expired-refresh-")
          )
            return "reauthenticate" as const;
          return yield* new Runtime.SessionExpired({});
        }
        if (
          current.claims.sub !== signedIn.claims.sub ||
          current.claims.sid !== signedIn.claims.sid
        )
          return yield* new Runtime.PrincipalChanged({});
        const liveViewer = yield* resolve;
        if (liveViewer === null || HttpServerResponse.isHttpServerResponse(liveViewer))
          return yield* new Runtime.AccessDenied({});
        if (liveViewer.user.id !== viewer.user.id || liveViewer.company.id !== viewer.company.id)
          return yield* new Runtime.PrincipalChanged({});
        return "live" as const;
      });
      return { companyId: viewer.company.id, viewerId: viewer.user.id, check };
    });
    return { admit };
  }
);
