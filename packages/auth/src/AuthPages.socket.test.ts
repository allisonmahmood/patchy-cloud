import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Cookies from "effect/http/Cookies";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CookieJar } from "tough-cookie";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { Analytics } from "@patchy/analytics";
import { Limits } from "@patchy/limits";
import * as AgentConnections from "./AgentConnections.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Testing from "@patchy/sql/testing";
import * as AuthPages from "./AuthPages.js";
import * as Receipt from "./Receipt.js";
import * as RequireSession from "./RequireSession.js";
import { pageResponse } from "./page.js";
import * as Session from "./Session.js";
import {
  clerkEnv,
  PUBLIC_BASE_URL,
  signedInCookies,
  signHandshake,
  signSession
} from "./testing.js";
import { NodeCryptography } from "@patchy/core";

const localRevocation = Layer.effect(
  Session.Session,
  Effect.map(Session.make, (session) => ({
    ...session,
    revoke: () => Effect.void
  }))
);
/**
 * Probes for receipts: a signed-in redirect, a signed-in page without the app shell, and one with
 * it, each the shape a real handler takes.
 */
const receiptProbes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/probe/hop",
      RequireSession.withViewer(Effect.succeed(HttpServerResponse.redirect("/probe/page")))
    );
    yield* router.add(
      "GET",
      "/probe/door",
      RequireSession.withViewer(
        Effect.succeed(pageResponse({ title: "Door", body: "<p>Door</p>" }))
      )
    );
    yield* router.add(
      "GET",
      "/probe/page",
      RequireSession.withViewer(
        Effect.map(RequireSession.Viewer, (viewer) =>
          pageResponse({ title: "Page", body: "<p>Page</p>", app: { viewer, section: "people" } })
        )
      )
    );
  })
);

const layer = HttpRouter.serve(Layer.mergeAll(AuthPages.layer, receiptProbes), {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(
    Layer.mergeAll(localRevocation, Companies.layer, Users.layer, InviteMail.layerRecording)
  ),
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(AgentConnections.layer),
  Layer.provide(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provide(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv()))),
  Layer.provide(NodeCryptography.layer)
);

it.layer(layer)("auth pages on a socket", (it) => {
  it.effect("bounds device forms before session admission, including chunked bodies", () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag === "UnixPathAddress") return assert.fail("Expected a TCP listener");
      const url = `http://127.0.0.1:${server.address.port}/login/device`;
      const body = new TextEncoder().encode(
        new URLSearchParams({
          code: "UNUSED",
          action: "confirm",
          machineName: "x".repeat(4_096)
        }).toString()
      );
      for (const streamed of [false, true]) {
        const options: RequestInit & { duplex?: "half" } = {
          method: "POST",
          headers: {
            origin: PUBLIC_BASE_URL,
            "content-type": "application/x-www-form-urlencoded"
          },
          body: streamed
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(body);
                  controller.close();
                }
              })
            : body,
          redirect: "manual",
          ...(streamed ? { duplex: "half" as const } : {})
        };
        const request = Effect.tryPromise(() => fetch(url, options));
        if (streamed) {
          // The server cuts an undeclared body off mid-stream, so the request fails.
          yield* request.pipe(Effect.flip);
        } else {
          const response = yield* request;
          assert.strictEqual(response.status, 413);
          assert.strictEqual(response.headers.get("location"), null);
          assert.include(yield* Effect.promise(() => response.text()), "Invalid form");
        }
      }
    })
  );

  it.effect(
    "drives handshake, create, membership and logout hops by hand with a browser cookie jar",
    () =>
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixPathAddress")
          return assert.fail("Expected a TCP listener");
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
  it.effect(
    "Use another account carries the longest consent request through sign-out to the door",
    () =>
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixPathAddress")
          return assert.fail("Expected a TCP listener");
        const socket = `http://127.0.0.1:${server.address.port}`;
        // The longest query consent answers, in a character that survives every re-serialization
        // and triples each time it is encoded again.
        const consent = `/oauth/authorize?state=${"+".repeat(2_042)}`;
        // What a browser adds, the page it came from included: the consent page sends
        // Referrer-Policy: same-origin, so its address rides along through the redirect.
        const browser = (referer: string) => ({
          referer,
          "user-agent": `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36`,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "sec-fetch-site": "same-origin"
        });
        const logout = yield* Effect.promise(() =>
          fetch(`${socket}/logout`, {
            method: "POST",
            headers: {
              origin: PUBLIC_BASE_URL,
              cookie: signedInCookies(signSession({ sub: "user_socket_switch" }))
            },
            body: new URLSearchParams({ return: consent }),
            redirect: "manual"
          })
        );
        assert.strictEqual(logout.status, 303);
        const login = `${PUBLIC_BASE_URL}${logout.headers.get("location")}`;
        // The redirect after signing out, and the worst hop after it: a page at that address
        // linking to a sign-in address as long, as dev personas' does.
        for (const referer of [`${PUBLIC_BASE_URL}${consent}`, login]) {
          const hop = yield* Effect.promise(() =>
            fetch(`${socket}${logout.headers.get("location")}`, {
              headers: browser(referer),
              redirect: "manual"
            })
          );
          assert.strictEqual(hop.status, 200);
        }
        const door = yield* Effect.promise(() =>
          fetch(`${socket}${logout.headers.get("location")}`, { redirect: "manual" })
        );
        const signIn = new URL(door.headers.get("x-patchy-sign-in-url")!);
        assert.strictEqual(signIn.searchParams.get("redirect_url"), `${PUBLIC_BASE_URL}${consent}`);
      })
  );
  it.effect(
    "keeps a receipt through redirects until a page shows it, and drops one left for someone else",
    () =>
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixPathAddress")
          return assert.fail("Expected a TCP listener");
        const socket = `http://127.0.0.1:${server.address.port}`;
        const { user } = yield* (yield* Companies.Companies).create({
          handle: "receipt-co",
          name: "Receipt Co",
          clerkUserId: "user_receipt",
          email: "receipt@example.com",
          userName: "Rae"
        });
        const session = signedInCookies(
          signSession({ sub: "user_receipt", email: "receipt@example.com", name: "Rae" })
        );
        // The cookie a form's redirect would have left, as the browser sends it back.
        const left = (userId: string) =>
          Cookies.toSetCookieHeaders(
            Receipt.set(HttpServerResponse.empty(), {
              userId,
              text: "Revoked <b>Mac</b>",
              publicBaseUrl: PUBLIC_BASE_URL
            }).cookies
          )[0]!.split(";")[0]!;
        const name = left(user.id).split("=")[0]!;
        const get = (path: string, receipt: string) =>
          Effect.promise(() =>
            fetch(`${socket}${path}`, {
              headers: { cookie: `${session}; ${receipt}` },
              redirect: "manual"
            })
          );
        const clears = (response: Response) =>
          response.headers
            .getSetCookie()
            .some((cookie) => cookie.startsWith(`${name}=;`) && cookie.includes("Max-Age=0"));

        const hop = yield* get("/probe/hop", left(user.id));
        assert.strictEqual(hop.status, 302);
        assert.isFalse(clears(hop), "a redirect leaves the receipt for the page it lands on");
        const door = yield* get("/probe/door", left(user.id));
        assert.isFalse(clears(door), "a page without the app shell can't show it, so leaves it");
        const page = yield* get("/probe/page", left(user.id));
        assert.strictEqual(page.status, 200);
        assert.include(
          yield* Effect.promise(() => page.text()),
          '<p class="note note-ok app-receipt" role="status">Revoked &lt;b&gt;Mac&lt;/b&gt;</p>'
        );
        assert.isTrue(clears(page), "the page that shows it clears it");
        assert.isNull(page.headers.get("x-patchy-receipt-shown"));

        const theirs = yield* get("/probe/hop", left("usr_someone_else"));
        assert.isTrue(clears(theirs), "someone else's receipt is dropped at once");
        const unseen = yield* get("/probe/page", left("usr_someone_else"));
        assert.notInclude(yield* Effect.promise(() => unseen.text()), "Revoked");
      })
  );
});
