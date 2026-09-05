import { assert, it } from "@effect/vitest";
import { CookieJar } from "tough-cookie";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Companies, Users } from "@patchy/companies";
import * as Testing from "@patchy/sql/testing";
import { DEV_SEED } from "./seed.js";
import * as AuthPages from "./AuthPages.js";
import { clerkEnv, externalRequests, signSession, signedInCookies } from "./testing.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const origin = new URL(base).origin;
const cookie = (sub: string, email = `${sub}@example.com`, name = "Alex") =>
  signedInCookies(signSession({ sub, email, name }));
const probe = HttpRouter.use((router) =>
  router.add(
    "GET",
    "/private",
    RequireSession.withViewer(
      Effect.map(RequireSession.Viewer, (viewer) => HttpServerResponse.jsonUnsafe(viewer))
    )
  )
);
const routes = Layer.mergeAll(AuthPages.layer, probe);
const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(routes);
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
    )
  );
  return HttpServerResponse.toWeb(response);
});
const post = (
  body: Record<string, string>,
  sessionCookie: string,
  extra: Record<string, string> = {}
): RequestInit => ({
  method: "POST",
  body: new URLSearchParams(body),
  headers: { cookie: sessionCookie, origin, ...extra }
});
const services = Layer.mergeAll(Session.layer, Companies.layer, Users.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);

it.layer(services)("first-party pages in memory", (it) => {
  it.effect("offers one portal link and confines its return to a local path", () =>
    Effect.gen(function* () {
      const login = yield* send("/login?return=%2Fprivate%3Fview%3Dmine");
      assert.strictEqual(login.status, 200);
      const body = yield* Effect.promise(() => login.text());
      assert.strictEqual((body.match(/<a /g) ?? []).length, 1);
      assert.include(body, encodeURIComponent(`${origin}/private?view=mine`));
      for (const target of [
        "https://foreign.invalid/",
        "//foreign.invalid/",
        "/.//foreign.invalid/",
        "//[",
        "/\\foreign.invalid/",
        "/\n/foreign.invalid/"
      ]) {
        const response = yield* send(`/login?return=${encodeURIComponent(target)}`);
        assert.strictEqual(response.status, 200);
        assert.include(
          yield* Effect.promise(() => response.text()),
          encodeURIComponent(`${origin}/join`)
        );
      }
    })
  );

  it.effect("answers a signed-out join with a door, not a redirect", () =>
    Effect.gen(function* () {
      const response = yield* send("/join");
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.headers.get("location"), null);
      assert.strictEqual(response.headers.get("www-authenticate"), null);
      assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
      assert.include(yield* Effect.promise(() => response.text()), "Sign in");
      assert.strictEqual(response.headers.get("x-clerk-auth-status"), null);
      assert.strictEqual(response.headers.get("access-control-allow-origin"), null);
    })
  );

  it.effect("creates a company with its admin and carries the return through enrollment", () =>
    Effect.gen(function* () {
      const sessionCookie = cookie("user_enroll");
      const protectedPage = yield* send("/private?view=mine", {
        headers: { cookie: sessionCookie }
      });
      assert.strictEqual(protectedPage.status, 303);
      const enrollment = protectedPage.headers.get("location")!;
      const page = yield* send(enrollment, { headers: { cookie: sessionCookie } });
      const html = yield* Effect.promise(() => page.text());
      assert.include(html, "user_enroll@example.com");
      assert.include(html, 'name="handle" value="alex-s-company"');
      assert.include(html, 'action="/logout"');
      assert.include(page.headers.get("content-security-policy")!, "form-action 'self'");
      // A no-referrer policy nulls a browser form's Origin and breaks the CSRF check.
      assert.strictEqual(page.headers.get("referrer-policy"), "same-origin");
      assert.include(html, "clerk.headless.js");
      assert.include(html, "/auth/session.js");
      const created = yield* send(
        enrollment,
        post({ action: "create", name: "Acme <Studio>", handle: "acme-enroll" }, sessionCookie)
      );
      assert.strictEqual(created.status, 303);
      assert.strictEqual(created.headers.get("location"), "/private?view=mine");
      const viewer = yield* send(created.headers.get("location")!, {
        headers: { cookie: sessionCookie }
      });
      const identity = yield* Effect.promise(() => viewer.json());
      assert.deepInclude(identity, { role: "admin" });
      const joined = yield* send("/join", { headers: { cookie: sessionCookie } });
      assert.include(yield* Effect.promise(() => joined.text()), "You are in Acme &lt;Studio&gt;");
      const unsafeReturn = yield* send(
        `/join?return=${encodeURIComponent("/safe/..//foreign.invalid/")}`,
        { headers: { cookie: sessionCookie } }
      );
      assert.strictEqual(unsafeReturn.status, 200);
      assert.strictEqual(unsafeReturn.headers.get("location"), null);
      assert.include(
        yield* Effect.promise(() => unsafeReturn.text()),
        "You are in Acme &lt;Studio&gt;"
      );
      const refused = yield* send(
        "/join",
        post({ action: "create", name: "Other", handle: "other-enroll" }, sessionCookie)
      );
      assert.strictEqual(refused.status, 409);
      assert.include(yield* Effect.promise(() => refused.text()), "Already in a company");
    })
  );

  it.effect("names every live invited company and consumes only the chosen invitation", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const other = yield* companies.create({
        handle: "invite-host",
        name: "Other Company",
        clerkUserId: "user_inviter",
        email: "inviter@example.com",
        userName: "Inviter"
      });
      const first = yield* companies.createInvite({
        companyId: DEV_SEED.companyId,
        email: "invitee@example.com",
        invitedBy: DEV_SEED.userId
      });
      const second = yield* companies.createInvite({
        companyId: other.company.id,
        email: "invitee@example.com",
        invitedBy: other.user.id,
        role: "admin"
      });
      const sessionCookie = cookie("user_invitee", "INVITEE@example.com");
      const page = yield* send("/join", { headers: { cookie: sessionCookie } });
      const html = yield* Effect.promise(() => page.text());
      assert.include(html, "Patchy Dev");
      assert.include(html, "Other Company");
      assert.notInclude(html, 'name="handle"');
      const create = yield* send(
        "/join",
        post(
          { action: "create", name: "Uninvited Company", handle: "uninvited-company" },
          sessionCookie
        )
      );
      assert.strictEqual(create.status, 409);
      assert.strictEqual(yield* (yield* Users.Users).findByClerkId("user_invitee"), null);
      const joined = yield* send(
        "/join",
        post({ action: "join", inviteId: second.id }, sessionCookie)
      );
      assert.strictEqual(joined.status, 303);
      const user = yield* (yield* Users.Users).findByClerkId("user_invitee");
      assert.strictEqual(user?.companyId, other.company.id);
      assert.strictEqual(user?.role, "admin");
      const remaining = yield* companies.findInvitesByEmail("invitee@example.com");
      assert.deepStrictEqual(
        remaining.map((invite) => invite.id),
        [first.id]
      );
      const refused = yield* send(
        "/join",
        post({ action: "join", inviteId: first.id }, sessionCookie)
      );
      assert.strictEqual(refused.status, 409);
    })
  );

  it.effect("keeps entered values when a handle is taken, reserved or malformed", () =>
    Effect.gen(function* () {
      for (const [handle, status] of [
        [DEV_SEED.companyHandle, 409],
        ["admin", 422],
        ["-invalid", 422]
      ] as const) {
        const response = yield* send(
          "/join",
          post(
            { action: "create", name: 'Keep "this"', handle },
            cookie(`user_bad_${status}_${handle}`)
          )
        );
        assert.strictEqual(response.status, status);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, "Keep &quot;this&quot;");
        assert.include(html, 'role="alert"');
      }
    })
  );

  it.effect("refuses foreign and missing Origin even when Fetch Metadata claims same-origin", () =>
    Effect.gen(function* () {
      for (const route of ["/join", "/logout"]) {
        for (const headers of [
          { origin: "https://foreign.invalid" },
          { "sec-fetch-site": "same-origin" }
        ]) {
          const response = yield* send(route, { method: "POST", headers });
          assert.strictEqual(response.status, 403);
          assert.strictEqual(response.headers.get("location"), null);
        }
      }
    })
  );

  it.effect("refreshes changed claims and gives deactivated users a sign-out page", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const created = yield* companies.create({
        handle: "viewer-refresh",
        name: "Viewer Company",
        clerkUserId: "user_viewer_admin",
        email: "viewer-admin@example.com",
        userName: "Admin"
      });
      const invite = yield* companies.createInvite({
        companyId: created.company.id,
        email: "viewer@example.com",
        invitedBy: created.user.id
      });
      const user = yield* companies.consumeInvite({
        inviteId: invite.id,
        clerkUserId: "user_viewer",
        email: "viewer@example.com",
        name: "Before"
      });
      const sessionCookie = cookie("user_viewer", "changed@example.com", "After");
      const response = yield* send("/private", { headers: { cookie: sessionCookie } });
      const identity = yield* Effect.promise(() => response.json());
      assert.deepInclude(identity, {
        user: { id: user.id, email: "changed@example.com", name: "After" }
      });
      yield* (yield* Users.Users).deactivate({ companyId: created.company.id, userId: user.id });
      for (const path of ["/private", "/join"]) {
        const denied = yield* send(path, { headers: { cookie: sessionCookie } });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.headers.get("cache-control"), "private, no-store");
        const html = yield* Effect.promise(() => denied.text());
        assert.include(html, "Ask an admin to reactivate it");
        assert.include(html, 'action="/logout"');
      }
      assert.deepStrictEqual(externalRequests, []);
    })
  );
  it.effect("keeps logout retryable when Clerk cannot revoke the session", () =>
    Effect.gen(function* () {
      const failure = Layer.effect(
        Session.Session,
        Effect.map(Session.make, (session) => ({
          ...session,
          revoke: () =>
            Effect.fail(
              new Session.SessionError({ operation: "revoke", cause: new Error("Unavailable") })
            )
        }))
      ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));
      const response = yield* send("/logout", post({}, cookie("user_revoke_failure"))).pipe(
        Effect.provide(failure)
      );
      assert.strictEqual(response.status, 502);
      assert.strictEqual(response.headers.get("location"), null);
      assert.deepStrictEqual(response.headers.getSetCookie(), []);
      assert.include(yield* Effect.promise(() => response.text()), 'action="/logout"');
    })
  );
});

// Only the external revocation capability is replaced; authentication uses the real verifier.
const localRevocation = Layer.effect(
  Session.Session,
  Effect.map(Session.make, (session) => ({
    ...session,
    revoke: () => Effect.void
  }))
);
it.layer(
  Layer.mergeAll(localRevocation, Companies.layer, Users.layer).pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
  )
)("logout without a company", (it) => {
  it.effect("clears every Clerk cookie scope and returns to the door with no user row", () =>
    Effect.gen(function* () {
      const response = yield* send("/logout", post({}, cookie("user_no_row")));
      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.get("location"), "/login");
      const jar = new CookieJar();
      for (const value of cookie("user_no_row").split("; "))
        jar.setCookieSync(`${value}; Path=/`, base);
      for (const value of response.headers.getSetCookie())
        jar.setCookieSync(value, base, { ignoreError: true });
      assert.strictEqual(jar.getCookieStringSync(base), "");
      const login = yield* send(response.headers.get("location")!);
      assert.strictEqual(login.status, 200);
      const next = yield* send("/join");
      assert.strictEqual(next.status, 401);
    })
  );
  it.effect("allows a deactivated user to sign out without resolving a Viewer", () =>
    Effect.gen(function* () {
      const companies = yield* Companies.Companies;
      const invite = yield* companies.createInvite({
        companyId: DEV_SEED.companyId,
        email: "deactivated-logout@example.com",
        invitedBy: DEV_SEED.userId
      });
      const user = yield* companies.consumeInvite({
        inviteId: invite.id,
        clerkUserId: "user_deactivated_logout",
        email: "deactivated-logout@example.com",
        name: "Departed"
      });
      yield* (yield* Users.Users).deactivate({ companyId: DEV_SEED.companyId, userId: user.id });
      const sessionCookie = cookie("user_deactivated_logout", "deactivated-logout@example.com");
      assert.strictEqual(
        (yield* send("/join", { headers: { cookie: sessionCookie } })).status,
        403
      );
      const response = yield* send("/logout", post({}, sessionCookie));
      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.get("location"), "/login");
    })
  );
});
