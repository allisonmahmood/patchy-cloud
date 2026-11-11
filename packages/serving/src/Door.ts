import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { RequireSession, Session, returnPath, unavailableDoor } from "@patchy/auth";
import type { Users } from "@patchy/companies";

/**
 * Who is asking, or the response that stands in for them: a sign-in door, a redirect to join, a
 * handshake or a refusal. Admission is optional here: only the handler knows whether the patch is
 * public. A public page asks it only whether the reader is one of the patch's own members, and
 * follows only the handshakes that `handshake` says recognise one.
 */
export class Admission extends Context.Service<
  Admission,
  {
    readonly result: RequireSession.Viewer["Service"] | HttpServerResponse.HttpServerResponse;
    readonly cookies: ReadonlyArray<string>;
    /** Which handshake a redirecting `result` is; see `Session.Handshake`. */
    readonly handshake: Session.Handshake | undefined;
  }
>()("@patchy/serving/Door/Admission") {}

const admission = Effect.gen(function* () {
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { result, cookies, handshake } = yield* RequireSession.admission;
  if (HttpServerResponse.isHttpServerResponse(result)) return { result, cookies, handshake };
  const viewer = yield* RequireSession.resolveViewer.pipe(
    Effect.provideService(RequireSession.SignedIn, result)
  );
  if (viewer !== null && !HttpServerResponse.isHttpServerResponse(viewer))
    yield* WideEvents.enrich({ viewerId: viewer.user.id, companyId: viewer.company.id });
  return {
    cookies,
    handshake,
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
        result: unavailableDoor("sign-in"),
        cookies: [],
        handshake: undefined
      }),
    SqlError: () =>
      Effect.succeed({
        result: unavailableDoor("patchy"),
        cookies: [],
        handshake: undefined
      })
  })
);

/** Who a top-level notice is for: an active signed-in viewer, or no one. */
interface NoticeAdmission {
  readonly viewer: RequireSession.Viewer["Service"] | undefined;
  readonly cookies: ReadonlyArray<string>;
}
const nobody: NoticeAdmission = { viewer: undefined, cookies: [] };

/**
 * Who a top-level notice at `/~shell/notice/:code` is for, if anyone, and the cookies Clerk set
 * reading the session, so a session it refreshed on the way stays refreshed. Unlike `Admission`
 * it never answers for the page, and never redirects:
 *
 * - A verified handshake return is admitted at once, with the cookies that complete it, rather
 *   than through Clerk's cleanup hop.
 * - A handshake Clerk wants to start is no one, and its cookies, which belong to the redirect,
 *   are dropped.
 * - So are a failed sign-in, no membership and a deactivated account.
 *
 * A person stopped on a notice always sees the notice.
 */
export const noticeViewer = Effect.gen(function* () {
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const result = yield* session.authenticate(
    new Request(new URL(request.url, session.publicBaseUrl), {
      method: request.method,
      headers: request.headers
    })
  );
  const { claims, cookies } =
    result.status === "signed-in"
      ? result
      : result.status === "signed-out"
        ? { claims: undefined, cookies: result.cookies }
        : result.kind === "completed"
          ? { claims: result.claims, cookies: result.response.headers.getSetCookie() }
          : { claims: undefined, cookies: [] };
  if (claims === undefined) return { viewer: undefined, cookies };
  const viewer = yield* RequireSession.resolveViewer.pipe(
    Effect.provideService(RequireSession.SignedIn, claims)
  );
  if (viewer === null || HttpServerResponse.isHttpServerResponse(viewer))
    return { viewer: undefined, cookies };
  yield* WideEvents.enrich({ viewerId: viewer.user.id, companyId: viewer.company.id });
  return { viewer, cookies };
}).pipe(
  Effect.catchTags({
    SessionError: () => Effect.succeed(nobody),
    SqlError: () => Effect.succeed(nobody)
  })
);

/** Installed only on patch addresses and content URLs; handlers own scope and cookies. */
export const layer = HttpRouter.middleware<{ provides: Admission }>()(
  Effect.gen(function* () {
    const services = yield* Effect.context<Session.Session | Users.Users>();
    return (app) =>
      Effect.gen(function* () {
        const decision = yield* admission.pipe(Effect.provide(services));
        return yield* Effect.provideService(app, Admission, decision);
      });
  })
).layer;
