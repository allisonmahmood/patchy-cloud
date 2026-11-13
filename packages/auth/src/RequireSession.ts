import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Users } from "@patchy/companies";
import { type PinnedPatch, copyLine, copyScriptPath, escapeHtml, linkButton } from "@patchy/core";
import * as Receipt from "./Receipt.js";
import * as Session from "./Session.js";
import * as TermsPrompt from "./TermsPrompt.js";
import { accountFoot, doorResponse, RECEIPT_SHOWN, returnPath, withCookies } from "./page.js";

export class Viewer extends Context.Service<
  Viewer,
  {
    readonly user: { readonly id: string; readonly email: string; readonly name: string };
    readonly company: { readonly id: string; readonly handle: string; readonly name: string };
    readonly role: Users.Role;
    /** The newest What's new release this person has seen; not part of who they are. */
    readonly whatsNewSeen: number;
    /** Their own choice whether patches' single-key shortcuts fire; a guest carries theirs. */
    readonly singleKeyShortcuts: boolean;
    /** Their pinned patches, for the sidebar; absent where no page is drawn, as under `withoutPins`. */
    readonly pins?: ReadonlyArray<PinnedPatch>;
    /** What their last form did, shown once on this page; see `Receipt`. */
    readonly receipt?: string | undefined;
    /** This page's local path, for a GET: the account menu's forms come back to it. */
    readonly page?: string | undefined;
  }
>()("@patchy/auth/RequireSession/Viewer") {}

/**
 * The viewer's pins for the sidebar, which `withViewer` reads for every page it answers. Hosting
 * supplies them, so Auth doesn't depend on Patches; without it nobody has any.
 */
export const Pins = Context.Reference<
  (viewer: Viewer["Service"]) => Effect.Effect<ReadonlyArray<PinnedPatch>, SqlError>
>("@patchy/auth/RequireSession/Pins", { defaultValue: () => () => Effect.succeed([]) });

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

/**
 * The signed-out door at `/`, `/login`, company pages and private patch addresses. With Clerk,
 * sign-up runs through its waitlist: a new person's account starts from an invitation email's
 * link, and anyone else can join the waitlist. The front page's door also gives the setup line
 * in its foot: an agent told only the instance's address reads this page first.
 */
export function door(
  session: Session.Session["Service"],
  path: string,
  failed = false,
  status = 401
) {
  const url = session.signInUrl(path);
  const signIn = linkButton("Sign in", url, { kind: "primary", block: true });
  const { waitlistUrl } = session;
  const setup =
    !failed && new URL(path, session.publicBaseUrl).pathname === "/"
      ? `<p>Setting up with an agent? Give it this line:</p>${copyLine(`Set up Patchy using ${new URL("/llms.txt", session.publicBaseUrl).href}`, "Setup line", "the setup line")}<script defer src="${copyScriptPath}"></script>`
      : undefined;
  return doorResponse(
    failed
      ? {
          title: "Sign-in could not complete",
          body: "<p>Try signing in again.</p>",
          actions: signIn,
          status
        }
      : {
          title: "Sign in to Patchy",
          body: `<p>Continue to your company’s patches.</p>${waitlistUrl === undefined ? "" : '<p class="meta">Patchy Cloud is in private beta. Invited, but new here? Start from the link in your invitation email. It creates your account.</p>'}`,
          actions:
            waitlistUrl === undefined
              ? signIn
              : `${signIn}${linkButton("Join the waitlist", waitlistUrl, { kind: "quiet", block: true })}`,
          ...(setup === undefined ? {} : { foot: setup }),
          status
        }
  ).pipe(HttpServerResponse.setHeader("x-patchy-sign-in-url", url));
}

/**
 * Shared cookie admission; a page's handler decides whether the result is required. `handshake`
 * says which handshake a redirecting `result` is, for a page that follows only some.
 */
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
      handshake: result.kind
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
      handshake: undefined
    };
  }
  return { result: result.claims, cookies: result.cookies, handshake: undefined };
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
      return doorResponse({
        title: "Request refused",
        body: "<p>Submit this form from this Patchy instance.</p>",
        status: 403
      });
    }
    return yield* app;
  });

/**
 * Claim refresh and deactivation are shared by enrollment, doored pages and tier 2 calls. Each
 * resolve reads current state: one read when the claims are unchanged, more statements when they
 * changed and need writing. A caller re-checks by resolving again.
 */
export const resolveViewer = Effect.gen(function* () {
  const claims = yield* SignedIn;
  const users = yield* Users.Users;
  const session = yield* Session.Session;
  const found = yield* users.refreshClaims({
    clerkUserId: claims.sub,
    email: claims.email,
    name: claims.name
  });
  if (!found) return null;
  const { user, company } = found;
  if (!company) return yield* Effect.die(new Error("User company is missing"));
  if (user.deactivatedAt) {
    return doorResponse(
      {
        title: "Your account is deactivated",
        body: `<p>Your account at ${escapeHtml(company.name)} is deactivated. Ask an admin to reactivate it.</p>`,
        foot: accountFoot(user.email),
        status: 403
      },
      session
    );
  }
  return Viewer.of({
    user: { id: user.id, email: user.email, name: user.name },
    company: { id: company.id, handle: company.handle, name: company.name },
    role: user.role,
    whatsNewSeen: user.whatsNewSeen,
    singleKeyShortcuts: user.singleKeyShortcuts
  });
});

const viewerPage = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  returnTo: string | undefined,
  terms: "prompt" | "pass",
  sidebar = true
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
      yield* WideEvents.enrich({ viewerId: viewer.user.id, companyId: viewer.company.id });
      const session = yield* Session.Session;
      // A receipt waiting for this page waits on through the prompt, for the page it goes on to.
      if (terms === "prompt") {
        const prompt = yield* TermsPrompt.prompt(session, viewer.user);
        if (prompt !== null) return prompt;
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const receipt = Receipt.take(request.cookies, {
        userId: viewer.user.id,
        publicBaseUrl: session.publicBaseUrl
      });
      const response = yield* Effect.provideService(app, Viewer, {
        ...viewer,
        ...(sidebar ? { pins: yield* (yield* Pins)(viewer) } : {}),
        receipt: receipt.text,
        page:
          request.method === "GET"
            ? (returnPath(request.url, session.publicBaseUrl) ?? undefined)
            : undefined
      });
      // A receipt waits through redirects and fragments for the page that shows it; one that
      // isn't this person's is cleared at once.
      const shown = response.headers[RECEIPT_SHOWN] !== undefined;
      return withCookies(
        HttpServerResponse.removeHeader(response, RECEIPT_SHOWN),
        shown || receipt.text === undefined ? receipt.clear : []
      );
    }),
    returnTo
  );

/**
 * A signed-in person's page: their viewer for `app`, or the way in first. A page load in a
 * browser by someone who hasn't accepted the current terms gets the terms prompt instead.
 */
export const withViewer = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  returnTo?: string
) => viewerPage(app, returnTo, "prompt");

/**
 * `withViewer` without their pins, for an answer that never draws the sidebar: a door, a bare
 * redirect, or a fragment a script asks for again and again.
 */
export const withoutPins = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  returnTo?: string
) => viewerPage(app, returnTo, "prompt", false);

/** `withViewer` without the terms prompt, for the prompt's own answer alone. */
export const forTerms = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  returnTo?: string
) => viewerPage(app, returnTo, "pass");

export const forEnrollment = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  withSession(
    Effect.gen(function* () {
      const viewer = yield* resolveViewer;
      if (HttpServerResponse.isHttpServerResponse(viewer)) return viewer;
      if (viewer)
        yield* WideEvents.enrich({ viewerId: viewer.user.id, companyId: viewer.company.id });
      return yield* Effect.provideService(app, Enrollment, viewer);
    })
  );
