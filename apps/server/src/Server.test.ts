/**
 * The server booted whole, as `start.ts` boots it: one upload goes in through
 * the API and comes out as a served page, with the headers a socket sees.
 * What each route does is its package's test; this proves the wiring.
 */
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/unstable/http/Cookies";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DEV_SEED } from "@patchy/auth/seed";
import {
  FRONTEND_API_HOST,
  signedInCookies,
  signHandshake,
  signSession
} from "@patchy/auth/testing";
import { answer, html, send, server, upload } from "./test/server.js";

const publicBaseUrl = "https://patchy.example";
const sessionCookie = (sub: string = DEV_SEED.clerkUserId, email: string = DEV_SEED.email) =>
  signedInCookies(signSession({ sub, email, azp: publicBaseUrl }));
const signedRequest = (path: string, cookie = sessionCookie()) =>
  HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("cookie", cookie));

it.effect("refuses startup without an explicit public base URL", () =>
  Effect.gen(function* () {
    const error = yield* server({ PATCHY_PUBLIC_BASE_URL: undefined }).pipe(
      Layer.build,
      Effect.scoped,
      Effect.flip
    );
    assert.strictEqual(error._tag, "ConfigError");
    assert.include(error.message, "PATCHY_PUBLIC_BASE_URL");
  })
);

it.layer(
  server({
    PATCHY_PUBLIC_BASE_URL: "https://patchy.example",
    PATCHY_TRUST_PROXY: "127.0.0.1"
  }).pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })))
)("the server, booted whole", (it) => {
  it.effect("answers health and the API, uncached", () =>
    Effect.gen(function* () {
      const health = yield* send(HttpClientRequest.get("/healthz"));
      assert.deepStrictEqual(yield* answer(health), { status: 200, body: { ok: true } });
      assert.strictEqual(health.headers["cache-control"], "no-store");
      assert.strictEqual(health.headers["x-content-type-options"], "nosniff");

      const me = yield* send(
        HttpClientRequest.get("/api/me").pipe(HttpClientRequest.bearerToken(DEV_SEED.token))
      );
      assert.deepStrictEqual(yield* answer(me), {
        status: 200,
        body: {
          user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
          company: {
            id: DEV_SEED.companyId,
            handle: DEV_SEED.companyHandle,
            name: DEV_SEED.companyName
          },
          role: DEV_SEED.role,
          machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
        }
      });
      assert.strictEqual(me.headers["cache-control"], "no-store");
      assert.deepStrictEqual(yield* answer(yield* send(HttpClientRequest.get("/api/me"))), {
        status: 401,
        body: { ok: false, error: "Missing or invalid API token." }
      });
    })
  );

  it.effect("publishes through the API and serves the page, attributed through the proxy", () =>
    Effect.gen(function* () {
      const created = yield* send(
        HttpClientRequest.post("/api/uploads").pipe(
          HttpClientRequest.bearerToken(DEV_SEED.token),
          HttpClientRequest.setHeader("x-forwarded-for", "203.0.113.9, 198.51.100.7"),
          HttpClientRequest.bodyJsonUnsafe({ html: html("Booted") })
        )
      );
      const body = (yield* created.json) as { patchId: string; publicUrl: string };
      assert.strictEqual(created.status, 201);
      assert.strictEqual(body.publicUrl, `https://patchy.example/d/${body.patchId}`);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET scope = 'public' WHERE id = ${body.patchId}`;

      for (const path of [`/d/${body.patchId}`, `/d/${body.patchId}/v/1`]) {
        const page = yield* send(HttpClientRequest.get(path));
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers["x-robots-tag"], "noindex");
        assert.strictEqual(page.headers["cache-control"], "public, max-age=60");
        const content = yield* page.text;
        assert.include(content, "Booted");
        assert.notInclude(content, "<script");
        assert.notInclude(page.headers["content-security-policy"]!, FRONTEND_API_HOST);

        const head = yield* send(HttpClientRequest.head(path));
        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers["cache-control"], page.headers["cache-control"]);
        assert.strictEqual(
          head.headers["content-security-policy"],
          page.headers["content-security-policy"]
        );
        assert.strictEqual(yield* head.text, "");
      }

      // The socket is the trusted proxy, so the rightmost address it did not
      // add is the client's — and that is what the version records.
      const rows = yield* sql<{ source_ip: string }>`
        SELECT source_ip FROM patch_versions WHERE patch_id = ${body.patchId}`;
      assert.deepStrictEqual(rows, [{ source_ip: "198.51.100.7" }]);

      // A direct request records the socket's own address, whatever it claims.
      const direct = yield* upload(DEV_SEED.token, { html: html("Direct") });
      assert.strictEqual(direct.status, 201);
      const directBody = (yield* direct.json) as { patchId: string };
      const [second] = yield* sql<{ source_ip: string }>`
          SELECT source_ip FROM patch_versions WHERE patch_id = ${directBody.patchId}`;
      // Dual-stack in the test; the address family is the socket's business.
      assert.match(second?.source_ip ?? "", /(^|:)127\.0\.0\.1$/);
    })
  );

  it.effect("keeps company pages behind the same door and returns from the sign-in handshake", () =>
    Effect.gen(function* () {
      const created = yield* upload(DEV_SEED.token, { html: html("Company secret") });
      const { patchId } = (yield* created.json) as { patchId: string };
      const patchPath = `/d/${patchId}`;
      for (const path of [
        patchPath,
        `${patchPath}/v/1`,
        "/d/missing12345",
        "/d/missing12345/v/1"
      ]) {
        const door = yield* send(HttpClientRequest.get(path));
        assert.strictEqual(door.status, 401);
        assert.strictEqual(door.headers["cache-control"], "private, no-store");
        assert.strictEqual(door.headers["content-type"], "text/html");
        assert.isUndefined(door.headers.location);
        assert.isUndefined(door.headers["www-authenticate"]);
        const signInUrl = new URL(door.headers["x-patchy-sign-in-url"]!);
        assert.strictEqual(signInUrl.searchParams.get("redirect_url"), `${publicBaseUrl}${path}`);
        const body = yield* door.text;
        assert.strictEqual(body.match(/<a\b/g)?.length, 1);
        assert.notInclude(body, "Company secret");
        assert.notInclude(body, "<iframe");
        const login = yield* send(
          HttpClientRequest.get(`/login?return=${encodeURIComponent(path)}`)
        );
        assert.strictEqual(yield* login.text, body, "the door and /login share one renderer");

        const bearer = yield* send(
          HttpClientRequest.get(path).pipe(HttpClientRequest.bearerToken(DEV_SEED.token))
        );
        assert.strictEqual(bearer.status, 401);
        assert.strictEqual(yield* bearer.text, body, "a machine token cannot open a company page");
        const head = yield* send(HttpClientRequest.head(path));
        assert.strictEqual(head.status, 401);
        assert.strictEqual(head.headers["cache-control"], "private, no-store");
        assert.strictEqual(
          head.headers["x-patchy-sign-in-url"],
          door.headers["x-patchy-sign-in-url"]
        );
        assert.strictEqual(yield* head.text, "");
      }

      const directives = sessionCookie()
        .split("; ")
        .map((value) => `${value}; Path=/; SameSite=Lax`);
      const handshake = yield* send(
        HttpClientRequest.get(
          `${patchPath}?__clerk_handshake=${encodeURIComponent(signHandshake(directives))}`
        )
      );
      assert.strictEqual(handshake.status, 307);
      assert.strictEqual(handshake.headers["cache-control"], "private, no-store");
      const target = new URL(handshake.headers.location!, publicBaseUrl);
      assert.strictEqual(`${target.pathname}${target.search}`, patchPath);
      const cookie = Cookies.toCookieHeader(handshake.cookies);
      for (const path of [patchPath, `${patchPath}/v/1`]) {
        const page = yield* send(signedRequest(path, cookie));
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers["cache-control"], "private, no-store");
        const body = yield* page.text;
        assert.include(body, "Company secret");
        assert.include(body, 'sandbox=""');
        assert.include(
          body,
          `https://${FRONTEND_API_HOST}/npm/@clerk/clerk-js@5/dist/clerk.headless.browser.js`
        );
        assert.include(body, 'src="/auth/session.js"');
        const csp = page.headers["content-security-policy"]!;
        assert.include(csp, `https://${FRONTEND_API_HOST}`);
        assert.notInclude(
          csp.split("; ").find((directive) => directive.startsWith("script-src"))!,
          "'unsafe-inline'"
        );

        const head = yield* send(
          HttpClientRequest.head(path).pipe(HttpClientRequest.setHeader("cookie", cookie))
        );
        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers["cache-control"], "private, no-store");
        assert.strictEqual(yield* head.text, "");
      }
      // The same browser session opens another company patch without visiting sign-in again.
      const second = yield* upload(DEV_SEED.token, { html: html("Colleague link") });
      const secondPatch = (yield* second.json) as { patchId: string };
      assert.strictEqual(
        (yield* send(signedRequest(`/d/${secondPatch.patchId}`, cookie))).status,
        200
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_socket_colleague', 'user_socket_colleague', ${DEV_SEED.companyId},
          'colleague@example.com', 'Colleague', 'member')`;
      const colleague = yield* send(
        signedRequest(patchPath, sessionCookie("user_socket_colleague", "colleague@example.com"))
      );
      assert.strictEqual(colleague.status, 200);
      assert.include(yield* colleague.text, "Company secret");
    })
  );

  it.effect("conceals company patches at PostgreSQL version boundaries", () =>
    Effect.gen(function* () {
      const created = yield* upload(DEV_SEED.token, { html: html("Version boundary secret") });
      const { patchId } = (yield* created.json) as { patchId: string };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name)
        VALUES ('cmp_version_foreign', 'version-foreign', 'Foreign')`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_version_foreign', 'user_version_foreign', 'cmp_version_foreign',
          'version-foreign@example.com', 'Foreign', 'member')`;
      yield* sql`UPDATE patch_versions SET version_number = 2147483647 WHERE patch_id = ${patchId}`;
      const foreignCookie = sessionCookie("user_version_foreign", "version-foreign@example.com");
      for (const version of ["2147483647", "2147483648", "9007199254740993"]) {
        const path = `/d/${patchId}/v/${version}`;
        const missingPath = `/d/missing12345/v/${version}`;
        const door = yield* send(HttpClientRequest.get(path));
        const missingDoor = yield* send(HttpClientRequest.get(missingPath));
        assert.strictEqual(door.status, 401);
        assert.strictEqual(missingDoor.status, 401);
        assert.strictEqual(door.headers["cache-control"], "private, no-store");
        assert.strictEqual(missingDoor.headers["cache-control"], "private, no-store");
        assert.strictEqual(
          (yield* door.text).replaceAll(encodeURIComponent(path), "PATCH"),
          (yield* missingDoor.text).replaceAll(encodeURIComponent(missingPath), "PATCH")
        );
        const foreign = yield* send(signedRequest(path, foreignCookie));
        const missing = yield* send(signedRequest(missingPath, foreignCookie));
        assert.strictEqual(foreign.status, 404);
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(foreign.headers["cache-control"], "private, no-store");
        assert.strictEqual(yield* foreign.text, yield* missing.text);
        assert.deepStrictEqual(
          Object.fromEntries(Object.entries(foreign.headers).filter(([name]) => name !== "date")),
          Object.fromEntries(Object.entries(missing.headers).filter(([name]) => name !== "date"))
        );
      }
      const lastValid = yield* send(signedRequest(`/d/${patchId}/v/2147483647`));
      assert.strictEqual(lastValid.status, 200);
      assert.include(yield* lastValid.text, "Version boundary secret");
      assert.strictEqual((yield* send(signedRequest(`/d/${patchId}/v/2147483648`))).status, 404);
    })
  );

  it.effect("completes a public patch handshake before serving its cacheable document", () =>
    Effect.gen(function* () {
      const created = yield* upload(DEV_SEED.token, { html: html("Public handshake") });
      const { patchId } = (yield* created.json) as { patchId: string };
      const privateUpload = yield* upload(DEV_SEED.token, { html: html("Signed-in destination") });
      const privatePatch = (yield* privateUpload.json) as { patchId: string };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET scope = 'public' WHERE id = ${patchId}`;
      for (const path of [`/d/${patchId}`, `/d/${patchId}/v/1`]) {
        const target = `${path}?view=chart`;
        const directives = sessionCookie()
          .split("; ")
          .map((value) => `${value}; Path=/; SameSite=Lax`);
        const response = yield* send(
          HttpClientRequest.get(
            `${target}&__clerk_handshake=${encodeURIComponent(signHandshake(directives))}`
          )
        );
        assert.strictEqual(response.status, 307);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        assert.strictEqual(response.headers.location, `${publicBaseUrl}${target}`);
        const cookie = Cookies.toCookieHeader(response.cookies);
        const page = yield* send(signedRequest(target, cookie));
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers["cache-control"], "public, max-age=60");
        assert.deepStrictEqual(Cookies.toSetCookieHeaders(page.cookies), []);
        assert.notInclude(yield* page.text, "<script");
        const companyPage = yield* send(signedRequest(`/d/${privatePatch.patchId}`, cookie));
        assert.strictEqual(
          companyPage.status,
          200,
          "the completed handshake must establish the session"
        );
        assert.include(yield* companyPage.text, "Signed-in destination");

        // A cold browser may initiate a handshake, but public access must not require it.
        const cold = yield* send(
          signedRequest(
            path,
            signedInCookies(signSession({ azp: publicBaseUrl, iat: 1, nbf: 1, exp: 2 }))
          ).pipe(HttpClientRequest.setHeader("accept", "text/html"))
        );
        assert.strictEqual(cold.status, 200);
        assert.strictEqual(cold.headers["cache-control"], "public, max-age=60");
        assert.isUndefined(cold.headers.location);
        assert.deepStrictEqual(Cookies.toSetCookieHeaders(cold.cookies), []);
      }
    })
  );

  it.effect(
    "conceals foreign patches and drives enrollment and deactivation responses by hand",
    () =>
      Effect.gen(function* () {
        const created = yield* upload(DEV_SEED.token, { html: html("Restricted content") });
        const { patchId } = (yield* created.json) as { patchId: string };
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_socket_foreign', 'socket-foreign', 'Foreign')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_socket_foreign', 'user_socket_foreign', 'cmp_socket_foreign', 'foreign@example.com', 'Foreign', 'member'),
          ('usr_socket_inactive', 'user_socket_inactive', ${DEV_SEED.companyId}, 'inactive@example.com', 'Inactive', 'member')`;
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_socket_inactive'`;
        const foreignCookie = sessionCookie("user_socket_foreign", "foreign@example.com");
        const inactiveCookie = sessionCookie("user_socket_inactive", "inactive@example.com");
        const unenrolledCookie = sessionCookie("user_socket_unenrolled", "unenrolled@example.com");
        // Leave a day on the retention window so an unauthorized visit would visibly top it up.
        const expiresAt = new Date((yield* Clock.currentTimeMillis) + 86_400_000).toISOString();
        yield* sql`UPDATE patches SET expires_at = ${expiresAt} WHERE id = ${patchId}`;
        const [before] = yield* sql`SELECT expires_at FROM patches WHERE id = ${patchId}`;
        for (const suffix of ["", "/v/1"]) {
          const patchPath = `/d/${patchId}${suffix}`;
          const missingPath = `/d/missing12345${suffix}`;
          const foreign = yield* send(signedRequest(patchPath, foreignCookie));
          const missing = yield* send(signedRequest(missingPath, foreignCookie));
          assert.strictEqual(foreign.status, 404);
          assert.strictEqual(missing.status, 404);
          assert.strictEqual(foreign.headers["cache-control"], "private, no-store");
          assert.strictEqual(yield* foreign.text, yield* missing.text);
          assert.deepStrictEqual(
            Object.fromEntries(Object.entries(foreign.headers).filter(([name]) => name !== "date")),
            Object.fromEntries(Object.entries(missing.headers).filter(([name]) => name !== "date"))
          );

          const noSession = yield* send(HttpClientRequest.get(patchPath));
          const missingNoSession = yield* send(HttpClientRequest.get(missingPath));
          assert.strictEqual(noSession.status, missingNoSession.status);
          assert.strictEqual(noSession.status, 401);
          // Only the return URL varies; neither response may reveal patch existence.
          assert.strictEqual(
            (yield* noSession.text).replaceAll(encodeURIComponent(patchPath), "PATCH"),
            (yield* missingNoSession.text).replaceAll(encodeURIComponent(missingPath), "PATCH")
          );

          const unenrolled = yield* send(signedRequest(patchPath, unenrolledCookie));
          assert.strictEqual(unenrolled.status, 303);
          assert.strictEqual(unenrolled.headers["cache-control"], "private, no-store");
          assert.strictEqual(
            unenrolled.headers.location,
            `/join?return=${encodeURIComponent(patchPath)}`
          );
          const join = yield* send(signedRequest(unenrolled.headers.location!, unenrolledCookie));
          assert.strictEqual(join.status, 200);
          assert.include(
            yield* join.text,
            `action="/join?return=${encodeURIComponent(patchPath)}"`
          );

          const deactivated = yield* send(signedRequest(patchPath, inactiveCookie));
          assert.strictEqual(deactivated.status, 403);
          assert.strictEqual(deactivated.headers["cache-control"], "private, no-store");
          const deactivatedBody = yield* deactivated.text;
          assert.include(deactivatedBody, 'action="/logout"');
          assert.notInclude(deactivatedBody, "Restricted content");

          const head = yield* send(
            HttpClientRequest.head(patchPath).pipe(
              HttpClientRequest.setHeader("cookie", foreignCookie)
            )
          );
          assert.strictEqual(head.status, 404);
          assert.strictEqual(head.headers["cache-control"], "private, no-store");
          assert.strictEqual(yield* head.text, "");
        }
        const [after] = yield* sql`SELECT expires_at FROM patches WHERE id = ${patchId}`;
        assert.deepStrictEqual(after, before, "refused visits must not keep a patch alive");
        for (const path of ["/healthz", "/login", "/auth/session.js", "/not-a-route"]) {
          const get = yield* send(HttpClientRequest.get(path));
          const head = yield* send(HttpClientRequest.head(path));
          assert.strictEqual(head.status, get.status, `HEAD ${path} follows GET admission`);
          assert.strictEqual(head.headers["content-type"], get.headers["content-type"]);
          assert.strictEqual(yield* head.text, "");
        }
      })
  );
});
