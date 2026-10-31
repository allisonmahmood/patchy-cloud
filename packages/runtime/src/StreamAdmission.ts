import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RequireSession, Session } from "@patchy/auth";
import type { RuntimeMe } from "@patchy/api";
import * as GrantedGuests from "./GrantedGuests.js";
import type * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";

type Dependencies =
  | Session.Session
  | GrantedGuests.GrantedGuests
  | LoadedVersions.LoadedVersions
  | Exclude<Effect.Services<typeof RequireSession.resolveViewer>, RequireSession.SignedIn>;
export interface Identity {
  readonly companyId: string;
  readonly viewerId: string;
  readonly expiresAt: number;
  readonly identity: NonNullable<RuntimeMe>;
}

/** A verified sign-in, before anything about a patch is read. */
export interface Admitted {
  readonly viewerId: string;
  readonly expiresAt: number;
  /** Who they are to a loaded version, as its member or guest, and how to ask again. */
  readonly viewer: (
    loaded: LoadedVersions.LoadedVersion
  ) => Effect.Effect<
    Identity & { readonly recheck: Effect.Effect<Identity, Runtime.RuntimeError> },
    Runtime.RuntimeError
  >;
}

/** Production verifies cookies; dev supplies its two explicit mount identities.
 * @effect-expect-leaking HttpServerRequest
 */
export class StreamAdmission extends Context.Service<
  StreamAdmission,
  {
    readonly admit: Effect.Effect<
      Admitted,
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
    const guestContext = yield* Effect.context<
      GrantedGuests.GrantedGuests | LoadedVersions.LoadedVersions
    >();
    const signIn = Effect.gen(function* () {
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
      const person = yield* RequireSession.resolveViewer.pipe(
        Effect.provideContext(viewerContext),
        Effect.provideService(RequireSession.SignedIn, signedIn.claims),
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
      );
      if (person === null || HttpServerResponse.isHttpServerResponse(person))
        return yield* new Runtime.AccessDenied({});
      return { person, expiresAt: signedIn.claims.exp * 1_000 };
    });
    const identity = (
      viewer: Option.Option<NonNullable<RuntimeMe>>,
      expiresAt: number
    ): Effect.Effect<Identity, Runtime.RuntimeError> =>
      Option.match(viewer, {
        onNone: () => Effect.fail(new Runtime.AccessDenied({})),
        onSome: (identity) =>
          Effect.succeed({
            companyId: identity.company.id,
            viewerId: identity.user.id,
            expiresAt,
            identity
          })
      });
    return StreamAdmission.of({
      admit: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { person, expiresAt } = yield* signIn;
        return {
          viewerId: person.user.id,
          expiresAt,
          viewer: (loaded) =>
            Effect.gen(function* () {
              const admitted = yield* GrantedGuests.viewerOf(loaded, person).pipe(
                Effect.provideContext(guestContext),
                Effect.flatMap((viewer) => identity(viewer, expiresAt))
              );
              const recheck = Effect.gen(function* () {
                const current = yield* signIn;
                if (current.person.company.id !== person.company.id)
                  return yield* new Runtime.AccessDenied({});
                const viewer = yield* GrantedGuests.recheck(
                  loaded,
                  admitted.identity,
                  current.person
                ).pipe(Effect.provideContext(guestContext));
                return yield* identity(viewer, current.expiresAt);
              }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
              return { ...admitted, recheck };
            })
        };
      })
    });
  }
);

export const layer = Layer.effect(StreamAdmission, make);
