import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Companies, Users } from "@patchy/companies";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import * as Session from "./Session.js";
import { pageResponse, returnPath, signOutForm, withCookies } from "./page.js";

export class Viewer extends Context.Service<
  Viewer,
  {
    readonly user: { readonly id: string; readonly email: string; readonly name: string };
    readonly company: { readonly id: string; readonly handle: string; readonly name: string };
    readonly role: Users.Role;
  }
>()("@patchy/auth/RequireSession/Viewer") {}

export class SignedIn extends Context.Service<
  SignedIn,
  {
    readonly sub: string;
    readonly email: string;
    readonly name: string;
    readonly sid: string;
  }
>()("@patchy/auth/RequireSession/SignedIn") {}
/** Only the create-or-join adapter consumes this optional membership. */
export class Enrollment extends Context.Service<Enrollment, Viewer["Service"] | null>()(
  "@patchy/auth/RequireSession/Enrollment"
) {}

/** Account Portal has a different hostname in development and on a custom Clerk domain. */
export function signInUrl(session: Session.Session["Service"], path: string): string {
  const host = session.frontendApiHost;
  const portalHost = host.endsWith(".clerk.accounts.dev")
    ? host.replace(/\.clerk\.accounts\.dev$/, ".accounts.dev")
    : host.replace(/^clerk\./, "accounts.");
  const url = new URL(`https://${portalHost}/sign-in`);
  const target = new URL(path, session.publicBaseUrl);
  // A new sign-in must not replay the signed-out handshake that showed the door.
  target.searchParams.delete("__clerk_handshake");
  target.searchParams.delete("__clerk_handshake_nonce");
  url.searchParams.set("redirect_url", target.href);
  return url.href;
}

export function door(
  session: Session.Session["Service"],
  path: string,
  failed = false,
  status = 401
) {
  const url = signInUrl(session, path);
  return pageResponse({
    title: failed ? "Sign-in could not complete" : "Sign in to Patchy",
    body: `<p>${failed ? "Try signing in again." : "Continue to your company."}</p><a class="auth-action" href="${escapeAttribute(url)}">Sign in</a>`,
    status
  }).pipe(HttpServerResponse.setHeader("x-patchy-sign-in-url", url));
}

/** Shared cookie admission; a page's handler decides whether the result is required. */
export const admission = Effect.gen(function* () {
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = returnPath(request.url, session.publicBaseUrl) ?? "/join";
  const result = yield* session.authenticate(
    new Request(new URL(request.url, session.publicBaseUrl), {
      method: request.method,
      headers: request.headers
    })
  );
  if (result.status === "handshake") {
    return {
      result: HttpServerResponse.empty({
        status: result.response.status,
        headers: {
          location: result.response.headers.get("location") ?? "/join",
          "cache-control": "private, no-store"
        }
      }),
      cookies: result.response.headers.getSetCookie(),
      completedHandshake: result.completed
    };
  }
  if (result.status === "signed-out") {
    if (result.handshakeFailed)
      yield* Effect.logWarning("Clerk sign-in could not complete").pipe(
        Effect.annotateLogs({ reason: result.reason })
      );
    return {
      result: door(session, path, result.handshakeFailed),
      cookies: result.cookies,
      completedHandshake: false
    };
  }
  return { result: result.claims, cookies: result.cookies, completedHandshake: false };
});

/** Session-only admission also serves logout, which must work before a user row exists. */
export const withSession = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  returnTo?: string
) =>
  Effect.gen(function* () {
    const { result, cookies } = yield* admission;
    const response = HttpServerResponse.isHttpServerResponse(result)
      ? returnTo === undefined
        ? result
        : HttpServerResponse.redirect(returnTo, {
            status: 303,
            headers: { "cache-control": "private, no-store" }
          })
      : yield* Effect.provideService(app, SignedIn, result);
    return withCookies(response, cookies);
  });

/** Every first-party POST is checked before authentication can start a handshake. */
export const sameOrigin = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* Session.Session;
    if (
      request.method === "POST" &&
      (request.headers.origin === undefined
        ? request.headers["sec-fetch-site"] !== "same-origin"
        : request.headers.origin !== new URL(session.publicBaseUrl).origin)
    ) {
      return pageResponse({
        title: "Request refused",
        body: "<p>Submit this form from this Patchy instance.</p>",
        status: 403
      });
    }
    return yield* app;
  });

/** Claim refresh and deactivation are shared by enrollment and ordinary doored pages. */
export const resolveViewer = Effect.gen(function* () {
  const claims = yield* SignedIn;
  const users = yield* Users.Users;
  const companies = yield* Companies.Companies;
  const session = yield* Session.Session;
  const user = yield* users.refreshClaims({
    clerkUserId: claims.sub,
    email: claims.email,
    name: claims.name
  });
  if (!user) return null;
  const company = yield* companies.findById(user.companyId);
  if (!company) return yield* Effect.die(new Error("User company is missing"));
  if (user.deactivatedAt) {
    return pageResponse(
      {
        title: "Your account is deactivated",
        body: `<p>Your account at ${escapeHtml(company.name)} is deactivated. Ask an admin to reactivate it.</p>${signOutForm()}`,
        status: 403
      },
      session
    );
  }
  return Viewer.of({
    user: { id: user.id, email: user.email, name: user.name },
    company: { id: company.id, handle: company.handle, name: company.name },
    role: user.role
  });
});

export const withViewer = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  returnTo?: string
) =>
  withSession(
    Effect.gen(function* () {
      const viewer = yield* resolveViewer;
      if (HttpServerResponse.isHttpServerResponse(viewer)) return viewer;
      if (!viewer) {
        const session = yield* Session.Session;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = returnTo ?? returnPath(request.url, session.publicBaseUrl) ?? "/join";
        return HttpServerResponse.redirect(`/join?return=${encodeURIComponent(path)}`, {
          status: 303,
          headers: { "cache-control": "private, no-store" }
        });
      }
      return yield* Effect.provideService(app, Viewer, viewer);
    }),
    returnTo
  );

export const forEnrollment = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  withSession(
    Effect.gen(function* () {
      const viewer = yield* resolveViewer;
      if (HttpServerResponse.isHttpServerResponse(viewer)) return viewer;
      return yield* Effect.provideService(app, Enrollment, viewer);
    })
  );
