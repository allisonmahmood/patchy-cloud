import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RequireSession, Session, pageResponse, returnPath } from "@patchy/auth";
import type { Companies, Users } from "@patchy/companies";

/** Admission is optional here: only the handler knows whether the patch is public. */
export class Admission extends Context.Service<
  Admission,
  {
    readonly result: RequireSession.Viewer["Service"] | HttpServerResponse.HttpServerResponse;
    readonly cookies: ReadonlyArray<string>;
    readonly completedHandshake: boolean;
  }
>()("@patchy/serving/Door/Admission") {}

const admission = Effect.gen(function* () {
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const decision = yield* RequireSession.admission;
  const { result } = decision;
  if (HttpServerResponse.isHttpServerResponse(result)) return decision;
  const viewer = yield* RequireSession.resolveViewer.pipe(
    Effect.provideService(RequireSession.SignedIn, result)
  );
  return {
    ...decision,
    result:
      viewer ??
      HttpServerResponse.redirect(
        `/join?return=${encodeURIComponent(returnPath(request.url, session.publicBaseUrl) ?? "/join")}`,
        {
          status: 303
        }
      )
  };
}).pipe(
  Effect.catchTags({
    SessionError: () =>
      Effect.succeed({
        result: pageResponse({
          title: "Sign-in service unavailable",
          body: "<p>Please try again.</p>",
          status: 502
        }),
        cookies: [],
        completedHandshake: false
      }),
    SqlError: () =>
      Effect.succeed({
        result: pageResponse({
          title: "Company service unavailable",
          body: "<p>Please try again.</p>",
          status: 503
        }),
        cookies: [],
        completedHandshake: false
      })
  })
);

/** Installed only on the two patch routes; the handler owns scope and response cookies. */
export const layer = HttpRouter.middleware<{ provides: Admission }>()(
  Effect.gen(function* () {
    const services = yield* Effect.context<Session.Session | Companies.Companies | Users.Users>();
    return (app) =>
      Effect.gen(function* () {
        const decision = yield* admission.pipe(Effect.provide(services));
        return yield* Effect.provideService(app, Admission, decision);
      });
  })
).layer;
