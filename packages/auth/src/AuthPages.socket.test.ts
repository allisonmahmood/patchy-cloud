import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { CookieJar } from "tough-cookie";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { Analytics } from "@patchy/analytics";
import { Limits } from "@patchy/limits";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Testing from "@patchy/sql/testing";
import * as AuthPages from "./AuthPages.js";
import * as Session from "./Session.js";
import {
  clerkEnv,
  PUBLIC_BASE_URL,
  signedInCookies,
  signHandshake,
  signSession
} from "./testing.js";

const localRevocation = Layer.effect(
  Session.Session,
  Effect.map(Session.make, (session) => ({
    ...session,
    revoke: () => Effect.void
  }))
);
const layer = HttpRouter.serve(AuthPages.layer, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(
    Layer.mergeAll(localRevocation, Companies.layer, Users.layer, InviteMail.layerRecording)
  ),
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provide(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provide(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);

it.layer(layer)("auth pages on a socket", (it) => {
  it.effect(
    "drives handshake, create, membership and logout hops by hand with a browser cookie jar",
    () =>
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        assert.strictEqual(server.address._tag, "TcpAddress");
        if (server.address._tag !== "TcpAddress") return;
        const socket = `http://127.0.0.1:${server.address.port}`;
        const jar = new CookieJar();
        const request = (path: string, options: RequestInit = {}) =>
          Effect.promise(async () => {
            const headers = new Headers(options.headers);
            const cookies = jar.getCookieStringSync(`${socket}${path}`);
            if (cookies) headers.set("cookie", cookies);
            const response = await fetch(`${socket}${path}`, {
              ...options,
              headers,
              redirect: "manual"
            });
            // Browsers ignore rejected public-suffix expiry candidates rather than failing the response.
            for (const value of response.headers.getSetCookie())
              jar.setCookieSync(value, `${socket}${path}`, { ignoreError: true });
            return response;
          });
        const login = yield* request("/login");
        assert.strictEqual(login.status, 200);
        assert.include(yield* Effect.promise(() => login.text()), "Sign in");
        const door = yield* request("/join");
        assert.strictEqual(door.status, 401);
        const jwt = signSession({
          sub: "user_socket",
          email: "socket@example.com",
          name: "Socket User"
        });
        const directives = signedInCookies(jwt)
          .split("; ")
          .map((value) => `${value}; Path=/; SameSite=Lax`);
        const handshake = yield* request(
          `/join?__clerk_handshake=${encodeURIComponent(signHandshake(directives))}`
        );
        assert.strictEqual(handshake.status, 307);
        assert.strictEqual(handshake.headers.get("access-control-allow-origin"), null);
        assert.strictEqual(handshake.headers.get("x-clerk-auth-status"), null);
        const target = new URL(handshake.headers.get("location")!);
        const createPage = yield* request(`${target.pathname}${target.search}`);
        assert.strictEqual(createPage.status, 200);
        assert.include(yield* Effect.promise(() => createPage.text()), "socket@example.com");
        const created = yield* request("/join", {
          method: "POST",
          headers: { origin: PUBLIC_BASE_URL },
          body: new URLSearchParams({
            action: "create",
            name: "Socket Company",
            handle: "socket-company"
          })
        });
        assert.strictEqual(created.status, 303);
        assert.strictEqual(created.headers.get("location"), "/company");
        const membership = yield* request(created.headers.get("location")!);
        assert.strictEqual(membership.status, 200);
        const membershipHtml = yield* Effect.promise(() => membership.text());
        assert.include(membershipHtml, 'action="/company/invites"');
        const logoutAction = membershipHtml.match(
          /<form\b[^>]*method="post"[^>]*action="(\/logout)"/
        )?.[1];
        assert.isDefined(logoutAction, "the enrolled home offers a sign-out form");
        const logout = yield* request(logoutAction!, {
          method: "POST",
          headers: { origin: PUBLIC_BASE_URL }
        });
        assert.strictEqual(logout.status, 303);
        assert.strictEqual(logout.headers.get("location"), "/login");
        assert.strictEqual(jar.getCookieStringSync(socket), "");
        assert.strictEqual((yield* request("/login")).status, 200);
        assert.strictEqual((yield* request("/join")).status, 401);
      })
  );

  it.effect("signs out before enrollment and refuses a foreign-origin logout", () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag !== "TcpAddress") return;
      const socket = `http://127.0.0.1:${server.address.port}`;
      const sessionCookie = signedInCookies(signSession({ sub: "user_socket_no_row" }));
      const foreign = yield* Effect.promise(() =>
        fetch(`${socket}/logout`, {
          method: "POST",
          headers: { cookie: sessionCookie, origin: "https://foreign.invalid" },
          redirect: "manual"
        })
      );
      assert.strictEqual(foreign.status, 403);
      assert.deepStrictEqual(foreign.headers.getSetCookie(), []);
      const logout = yield* Effect.promise(() =>
        fetch(`${socket}/logout`, {
          method: "POST",
          headers: { cookie: sessionCookie, origin: PUBLIC_BASE_URL },
          redirect: "manual"
        })
      );
      assert.strictEqual(logout.status, 303);
      assert.strictEqual(logout.headers.get("location"), "/login");
      const jar = new CookieJar();
      for (const value of sessionCookie.split("; ")) jar.setCookieSync(`${value}; Path=/`, socket);
      for (const value of logout.headers.getSetCookie())
        jar.setCookieSync(value, socket, { ignoreError: true });
      assert.strictEqual(jar.getCookieStringSync(socket), "");
      assert.strictEqual(yield* (yield* Users.Users).findByClerkId("user_socket_no_row"), null);
    })
  );
});
