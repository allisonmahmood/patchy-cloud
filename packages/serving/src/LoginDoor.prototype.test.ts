/**
 * PROTOTYPE for #119 — throwaway, delete with the branch. The test spike for
 * the login door, entirely offline through `@patchy/auth/testing`: a fake
 * Clerk instance whose hosts are unreachable by construction, sessions signed
 * by an RSA-2048 keypair and verified through `CLERK_JWT_KEY`, and a fetch
 * guard that refuses anything that is not this process's own loopback server.
 * Each test names the question it settles (T1–T6 on the ticket's test-spike
 * task).
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- the raw Node server is the fixture; sessions carry the real clock's time.
import { createServer } from "node:http";
import { assert, it, vi } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Cookies from "effect/unstable/http/Cookies";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ClerkSession, migrations as authMigrations, PrototypeUsers } from "@patchy/auth";
import {
  clerkEnv,
  cookieHeader,
  FRONTEND_API,
  nowSeconds,
  outbound,
  PUBLIC_BASE_URL,
  publishableKey,
  realFetch,
  seedDevAccount,
  sessionClaims,
  signedInCookies,
  signSession
} from "@patchy/auth/testing";
import { ContentStore } from "@patchy/content-store";
import { Content, migrations as patchesMigrations, Patches } from "@patchy/patches";
import * as Testing from "@patchy/sql/testing";
import * as Pages from "./Pages.js";
import { servingHeaders } from "./serving-headers.js";

// --- the server ---------------------------------------------------------------------

const memoryStore = Layer.sync(ContentStore.ContentStore, () => {
  const objects = new Map<string, string>();
  return ContentStore.ContentStore.of({
    put: (key, html) => Effect.sync(() => void objects.set(key, html)),
    get: (key) =>
      Effect.suspend(() => {
        const html = objects.get(key);
        return html === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(html);
      }),
    delete: (key) => Effect.sync(() => void objects.delete(key))
  });
});

/** The pages with the door's two services, behind the serving headers, as `Server.ts` wires them. */
const app = Layer.mergeAll(
  Pages.layer.pipe(Layer.provide([ClerkSession.layer, PrototypeUsers.layer])),
  HttpRouter.middleware(servingHeaders, { global: true })
);

/**
 * `NodeHttpServer.layerTest`'s client follows redirects and keeps no cookies,
 * so the door's 307 would never be seen. This is the same client built by
 * hand with `redirect: "manual"`, and with the unguarded fetch, so its own
 * requests are not counted as the server's network.
 */
const manualClient = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false, redirect: "manual" })
      ),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(realFetch))
    )
  )
);

const server = (instance: "test" | "live") =>
  HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(manualClient),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
    Layer.provideMerge(Content.layer),
    Layer.provideMerge(Layer.mergeAll(Patches.layer, memoryStore)),
    Layer.provideMerge(Layer.effectDiscard(seedDevAccount)),
    Layer.provideMerge(Testing.layer({ ...authMigrations, ...patchesMigrations })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv(instance))))
  );

const get = (url: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
  );

const publish = (title: string) =>
  Effect.flatMap(Content.Content, (content) =>
    content.upload({
      patchId: null,
      accountId: "acct_dev",
      apiTokenId: "tok_dev",
      title,
      html: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
      filename: null,
      repoOrg: null,
      repoName: null,
      cliVersion: null,
      gitBranch: null,
      gitCommitSha: null,
      sourceIp: null,
      userAgent: "vitest"
    })
  );

/** The handshake `Location` the SDK built, taken apart. */
const handshakeOf = (location: string | undefined) => {
  const url = new URL(location ?? "");
  return {
    origin: url.origin,
    pathname: url.pathname,
    params: [...url.searchParams.keys()],
    reason: url.searchParams.get("__clerk_hs_reason"),
    redirectUrl: url.searchParams.get("redirect_url")
  };
};

// --- a development instance ------------------------------------------------------------

it.layer(server("test"))("the login door on a development key, offline", (it) => {
  // T1. Does a session signed by the test keypair verify through jwtKey with
  // no network, and does the door then serve the patch and create the user row?
  it.effect("T1: jwtKey verifies the test keypair's session offline and the door serves", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("Behind the door");
      const iat = nowSeconds();
      const jwt = signSession(sessionClaims(iat, 60));
      outbound.length = 0;
      const log = vi.spyOn(console, "log");

      const response = yield* get(`/d/${patchId}`, {
        cookie: signedInCookies(jwt, iat),
        accept: "text/html"
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["cache-control"], "private, no-store");
      assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
      assert.isUndefined(response.headers["set-cookie"]);
      assert.include(yield* response.text, "Behind the door");

      // The row the door made just in time, in the seeded company.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ clerk_user_id: string; account_id: string; email: string }>`
        SELECT clerk_user_id, account_id, email FROM prototype_users`;
      assert.deepStrictEqual(rows, [
        { clerk_user_id: "user_test", account_id: "acct_dev", email: "door@example.com" }
      ]);

      // No network: the guard saw nothing leave, and the door's own line says so.
      assert.deepStrictEqual(outbound, []);
      const doorLine = log.mock.calls
        .map((call) => call.join(" "))
        .find((line) => line.startsWith(`[door] GET /d/${patchId} `));
      log.mockRestore();
      assert.include(doorLine, "status=signed-in");
      assert.include(doorLine, "net=0");
      assert.include(doorLine, `azp=${PUBLIC_BASE_URL} exp-iat=60`);
    })
  );

  // T2. Under Node's undici, does `redirect: "manual"` expose the real 307
  // and its Location, or a browser-style opaque redirect?
  it.effect(
    "T2: the fetch client on redirect: manual sees the handshake 307 and its location",
    () =>
      Effect.gen(function* () {
        const { patchId } = yield* publish("Handshake");
        const response = yield* get(`/d/${patchId}`, {
          cookie: cookieHeader({ __client_uat: "1", __clerk_db_jwt: "dev-browser" }),
          accept: "text/html"
        });
        assert.strictEqual(response.status, 307);
        assert.strictEqual(response.headers["cache-control"], "no-store");
        assert.strictEqual(response.headers["x-clerk-auth-status"], "handshake");

        const handshake = handshakeOf(response.headers["location"]);
        assert.strictEqual(handshake.origin, `https://${FRONTEND_API}`);
        assert.strictEqual(handshake.pathname, "/v1/client/handshake");
        assert.strictEqual(handshake.reason, "client-uat-but-no-session-token");
        assert.deepStrictEqual(handshake.params, [
          "redirect_url",
          "__clerk_api_version",
          "suffixed_cookies",
          "__clerk_hs_reason",
          "format",
          "__clerk_db_jwt"
        ]);
        // The door hands the SDK the public URL, but the SDK rebuilds the origin
        // from the `host` header it was given, so the socket's host wins here.
        const server = yield* HttpServer.HttpServer;
        const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
        assert.strictEqual(handshake.redirectUrl, `https://127.0.0.1:${port}/d/${patchId}`);

        // The loop guard the SDK sets on every handshake redirect.
        const counter = response.cookies.cookies["__clerk_redirect_count"];
        assert.strictEqual(counter?.value, "1");
        assert.strictEqual(counter?.options?.httpOnly, true);
        assert.strictEqual(counter?.options?.sameSite, "lax");
        assert.deepStrictEqual(Cookies.toSetCookieHeaders(response.cookies), [
          "__clerk_redirect_count=1; Max-Age=2; HttpOnly; SameSite=Lax"
        ]);
      })
  );

  // T3. Can the door be driven in memory — `HttpRouter.toHttpEffect` over the
  // doored pages, a Web `Request` in — with no socket, and does it decide
  // before the handler needs the patch to exist?
  it.effect(
    "T3: HttpRouter.toHttpEffect + HttpServerRequest.fromWeb drive the door in memory",
    () =>
      Effect.gen(function* () {
        const handler = yield* HttpRouter.toHttpEffect(
          app.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv("test"))))
          )
        );
        const request = HttpServerRequest.fromWeb(
          new Request("http://127.0.0.1/d/doesnotexist1", {
            headers: {
              cookie: cookieHeader({ __client_uat: "1", __clerk_db_jwt: "dev-browser" }),
              accept: "text/html"
            }
          })
        );
        const response = yield* handler.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request)
        );
        // The door answered for a patch that does not exist: it runs before the handler.
        assert.strictEqual(response.status, 307);
        const handshake = handshakeOf(response.headers["location"]);
        assert.strictEqual(handshake.origin, `https://${FRONTEND_API}`);
        assert.strictEqual(handshake.reason, "client-uat-but-no-session-token");
        // Under `fromWeb`, `originalUrl` is the absolute Web URL (on the Node
        // server it is the path), so the door's `new URL(originalUrl,
        // publicBaseUrl)` keeps the request's own origin here.
        assert.strictEqual(handshake.redirectUrl, "http://127.0.0.1/d/doesnotexist1");
        assert.deepStrictEqual(Cookies.toSetCookieHeaders(response.cookies), [
          "__clerk_redirect_count=1; Max-Age=2; HttpOnly; SameSite=Lax"
        ]);
        assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
      })
  );

  // T4. With `HttpClient.withCookiesRef` on the manual client, driving the hops
  // by hand: what does each answer set, and does the ref carry it into the next?
  it.effect(
    "T4: hand-driven hops through a cookie ref: the door sets nothing, the handshake counts",
    () =>
      Effect.gen(function* () {
        const { patchId } = yield* publish("Two hops");
        const jar = yield* Ref.make(Cookies.empty);
        const client = HttpClient.withCookiesRef(yield* HttpClient.HttpClient, jar);
        const hop = (headers: Record<string, string> = {}) =>
          client.execute(
            HttpClientRequest.get(`/d/${patchId}`).pipe(HttpClientRequest.setHeaders(headers))
          );

        // No cookies and no document Accept: the door, and it sets nothing.
        const door = yield* hop();
        assert.strictEqual(door.status, 401);
        assert.strictEqual(door.headers["x-clerk-auth-reason"], "dev-browser-missing");
        assert.isUndefined(door.headers["location"]);
        assert.isTrue(Cookies.isEmpty(yield* Ref.get(jar)));

        // The session in the ref: served, and the ref is left exactly as it was.
        const iat = nowSeconds();
        yield* Ref.set(
          jar,
          Cookies.fromSetCookie(
            signedInCookies(signSession(sessionClaims(iat, 60)), iat).split("; ")
          )
        );
        const served = yield* hop({ accept: "text/html" });
        assert.strictEqual(served.status, 200);
        assert.deepStrictEqual(Object.keys(Cookies.toRecord(yield* Ref.get(jar))).sort(), [
          "__clerk_db_jwt",
          "__client_uat",
          "__session"
        ]);

        // A client with no session: three handshake redirects, each counted
        // through the ref, then the SDK's loop guard gives up and the door shows.
        yield* Ref.set(
          jar,
          Cookies.fromSetCookie(["__client_uat=1", "__clerk_db_jwt=dev-browser"])
        );
        for (const expected of ["1", "2", "3"]) {
          const redirect = yield* hop({ accept: "text/html" });
          assert.strictEqual(redirect.status, 307, `redirect ${expected}`);
          assert.strictEqual(redirect.cookies.cookies["__clerk_redirect_count"]?.value, expected);
          assert.strictEqual(
            Cookies.toRecord(yield* Ref.get(jar))["__clerk_redirect_count"],
            expected
          );
        }
        const stopped = yield* hop({ accept: "text/html" });
        assert.strictEqual(stopped.status, 401);
        assert.strictEqual(
          stopped.headers["x-clerk-auth-reason"],
          "client-uat-but-no-session-token"
        );
        assert.isTrue(Cookies.isEmpty(stopped.cookies));
      })
  );

  // T5. Handshake eligibility with an expired session: which requests get the
  // 307, which get the door, and what does sign-out do with the same cookie?
  it.effect(
    "T5: an expired session handshakes only a document GET; sign-out still expires the cookies",
    () =>
      Effect.gen(function* () {
        const { patchId } = yield* publish("Expired");
        const iat = nowSeconds() - 180;
        const expired = signedInCookies(signSession(sessionClaims(iat, 60)), iat);

        const document = yield* get(`/d/${patchId}`, { cookie: expired, accept: "text/html" });
        assert.strictEqual(document.status, 307);
        const handshake = handshakeOf(document.headers["location"]);
        assert.strictEqual(
          handshake.reason,
          "session-token-expired-refresh-non-eligible-no-refresh-cookie"
        );
        // The expired token itself rides along in the handshake URL.
        assert.deepStrictEqual(handshake.params, [
          "redirect_url",
          "__clerk_api_version",
          "suffixed_cookies",
          "__clerk_hs_reason",
          "format",
          "__session",
          "__clerk_db_jwt"
        ]);

        const fetchLike = yield* get(`/d/${patchId}`, { cookie: expired, accept: "*/*" });
        assert.strictEqual(fetchLike.status, 401);
        assert.isUndefined(fetchLike.headers["location"]);
        assert.strictEqual(
          fetchLike.headers["x-clerk-auth-reason"],
          "session-token-expired-refresh-non-eligible-no-refresh-cookie"
        );
        assert.include(
          yield* fetchLike.text,
          `https://accounts.patchy.invalid/sign-in?redirect_url=`
        );

        // Sign-out from this origin: the verdict is signed-out (a POST is not
        // refresh-eligible), the revoke goes to BAPI and fails offline, and the
        // cookies are expired anyway. The 303 carries none of Clerk's headers,
        // so the verdict is read off the door's log line.
        outbound.length = 0;
        const log = vi.spyOn(console, "log");
        const signOut = (origin: string) =>
          Effect.flatMap(HttpClient.HttpClient, (client) =>
            client.execute(
              HttpClientRequest.post("/sign-out").pipe(
                HttpClientRequest.setHeaders({ cookie: expired, origin }),
                HttpClientRequest.bodyUrlParams({ next: `/d/${patchId}` })
              )
            )
          );
        const signedOut = yield* signOut(PUBLIC_BASE_URL);
        const lines = log.mock.calls.map((call) => call.join(" "));
        log.mockRestore();
        assert.strictEqual(signedOut.status, 303);
        assert.strictEqual(signedOut.headers["location"], `/d/${patchId}`);
        assert.isUndefined(signedOut.headers["x-clerk-auth-reason"]);
        assert.include(
          lines.find((line) => line.startsWith("[door] POST /sign-out ")),
          "status=signed-out reason=session-token-expired-refresh-non-eligible-non-get"
        );
        assert.include(lines, "[door]   revoke failed: Clerk refused to revoke session sess_test.");
        assert.deepStrictEqual(outbound, [
          "POST https://api.clerk.com/v1/sessions/sess_test/revoke"
        ]);
        const suffix = ClerkSession.cookieSuffixOf(publishableKey("test"));
        const expiredNames = ["__session", "__clerk_db_jwt", "__refresh"].flatMap((name) => [
          name,
          `${name}_${suffix}`
        ]);
        const cookies = signedOut.cookies.cookies;
        assert.deepStrictEqual(
          Object.keys(cookies).sort(),
          [...expiredNames, "__client_uat", `__client_uat_${suffix}`].sort()
        );
        for (const name of expiredNames) assert.strictEqual(cookies[name]?.value, "", name);
        assert.strictEqual(cookies["__client_uat"]?.value, "0");
        assert.strictEqual(cookies["__client_uat"]?.options?.domain, "patchy.example");
        assert.include(
          Cookies.toSetCookieHeaders(signedOut.cookies),
          "__session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        );

        // Sign-out from elsewhere: refused before anything is revoked or expired.
        const refused = yield* signOut("https://evil.example");
        assert.strictEqual(refused.status, 403);
        assert.isTrue(Cookies.isEmpty(refused.cookies));
        assert.deepStrictEqual(outbound, [
          "POST https://api.clerk.com/v1/sessions/sess_test/revoke"
        ]);
      })
  );

  // T6, the development half: a cookie-less document GET is a handshake, and
  // so is a perfectly good session without the dev-browser cookie.
  it.effect(
    "T6a: on a pk_test_ key a cookie-less document GET handshakes (dev-browser-missing)",
    () =>
      Effect.gen(function* () {
        const { patchId } = yield* publish("Dev key");
        const bare = yield* get(`/d/${patchId}`, { accept: "text/html" });
        assert.strictEqual(bare.status, 307);
        assert.strictEqual(handshakeOf(bare.headers["location"]).reason, "dev-browser-missing");

        const iat = nowSeconds();
        const withoutDevBrowser = signedInCookies(signSession(sessionClaims(iat, 60)), iat, {
          devBrowser: false
        });
        const session = yield* get(`/d/${patchId}`, {
          cookie: withoutDevBrowser,
          accept: "text/html"
        });
        assert.strictEqual(session.status, 307);
        assert.strictEqual(handshakeOf(session.headers["location"]).reason, "dev-browser-missing");
      })
  );
});

// --- a production instance -----------------------------------------------------------

it.layer(server("live"))("the login door on a production key, offline", (it) => {
  // T6, the production half: the same requests on a pk_live_ key.
  it.effect(
    "T6b: on a pk_live_ key a cookie-less document GET is the door, and a session alone serves",
    () =>
      Effect.gen(function* () {
        const { patchId } = yield* publish("Live key");
        outbound.length = 0;

        const bare = yield* get(`/d/${patchId}`, { accept: "text/html" });
        assert.strictEqual(bare.status, 401);
        assert.isUndefined(bare.headers["location"]);
        assert.isUndefined(bare.headers["set-cookie"]);
        assert.strictEqual(bare.headers["x-clerk-auth-status"], "signed-out");
        assert.strictEqual(bare.headers["x-clerk-auth-reason"], "session-token-and-uat-missing");
        assert.strictEqual(bare.headers["cache-control"], "no-store");
        assert.include(yield* bare.text, "session-token-and-uat-missing");

        const iat = nowSeconds();
        const session = yield* get(`/d/${patchId}`, {
          cookie: signedInCookies(signSession(sessionClaims(iat, 60)), iat, { devBrowser: false }),
          accept: "text/html"
        });
        assert.strictEqual(session.status, 200);
        assert.include(yield* session.text, "Live key");
        assert.deepStrictEqual(outbound, []);
      })
  );
});
