import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AuthPages, Session } from "@patchy/auth";
import {
  clerkEnv,
  signedInCookies,
  signSession,
  signHandshake,
  FRONTEND_API_HOST,
  PUBLIC_BASE_URL
} from "@patchy/auth/testing";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { DEV_SEED } from "@patchy/auth/seed";
import { ContentStore } from "@patchy/content-store";
import { Content, Patches } from "@patchy/patches";
import * as Testing from "@patchy/sql/testing";
import * as Pages from "./Pages.js";
import { servingHeaders } from "./serving-headers.js";

const DAY = 24 * 60 * 60 * 1000;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
  "frame-src 'self' about:; base-uri 'none'; form-action 'none'";

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

const routes = Layer.mergeAll(
  Pages.layer,
  AuthPages.layer,
  HttpRouter.middleware(servingHeaders, { global: true })
);
const services = Content.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Patches.layer,
      memoryStore,
      Session.layer,
      Companies.layer,
      Users.layer,
      InviteMail.layerRecording
    )
  ),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
/** The same routes and services in memory and on a real socket. */
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services)
);

const get = (url: string, headers: Record<string, string> = { cookie: signedInCookies() }) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
  );

const publish = (title: string) =>
  Effect.flatMap(Content.Content, (content) =>
    content.upload({
      patchId: null,
      companyId: DEV_SEED.companyId,
      ownerUserId: DEV_SEED.userId,
      machineTokenId: DEV_SEED.tokenId,
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

it.layer(layer)("pages", (it) => {
  it.effect("keeps company patches behind the login door without accepting machine tokens", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("Company only");
      const response = yield* get(`/d/${patchId}`, {
        authorization: "Bearer patchy-dev-token",
        cookie: ""
      });
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.headers["cache-control"], "private, no-store");
      assert.isUndefined(response.headers.location);
      assert.isUndefined(response.headers["www-authenticate"]);
      assert.include(yield* response.text, ">Sign in</a>");
    })
  );

  it.effect("serves a public patch script-free with at most a minute of caching on both URLs", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("Serving Guarantees");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET scope = 'public' WHERE id = ${patchId}`;
      for (const [url, cacheControl] of [
        [`/d/${patchId}`, "public, max-age=60"],
        [`/d/${patchId}/v/1`, "public, max-age=60"]
      ]) {
        // Invalid credentials never turn a public page into a challenge.
        const response = yield* get(url as string, {
          authorization: "Bearer not-a-real-token",
          cookie: "session=whatever"
        });
        assert.strictEqual(response.status, 200, url);
        assert.strictEqual(response.headers["x-robots-tag"], "noindex");
        assert.strictEqual(response.headers["referrer-policy"], "no-referrer");
        assert.strictEqual(response.headers["content-security-policy"], CSP);
        assert.strictEqual(response.headers["cache-control"], cacheControl);
        assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
        assert.isUndefined(response.headers["set-cookie"]);
        assert.isUndefined(response.headers["www-authenticate"]);
        const body = yield* response.text;
        assert.include(body, "Serving Guarantees");
        assert.include(body, 'class="patch-frame"');
        assert.include(body, "&lt;h1&gt;Serving Guarantees&lt;/h1&gt;");
        assert.notInclude(body, "<script");
        assert.notInclude(body, "<form");
      }
    })
  );

  it.effect("404s as HTML, uncached, and keeps a patch URL's headers on the 404 too", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("One version");
      for (const url of ["/d/doesnotexist1", `/d/${patchId}/v/9`, `/d/${patchId}/v/x`]) {
        const response = yield* get(url);
        assert.strictEqual(response.status, 404, url);
        assert.strictEqual(response.headers["x-robots-tag"], "noindex");
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        assert.include(response.headers["content-type"], "text/html");
        assert.notInclude(yield* response.text, "One version");
      }
      const elsewhere = yield* get("/nothing/here");
      assert.strictEqual(elsewhere.status, 404);
      assert.strictEqual(elsewhere.headers["cache-control"], "no-store");
      assert.include(elsewhere.headers["content-type"], "text/html");

      for (const url of ["/", "/healthz"]) {
        const response = yield* get(url);
        assert.strictEqual(response.status, 200, url);
        assert.strictEqual(response.headers["cache-control"], "no-store");
        assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
      }
      assert.include(yield* (yield* get("/")).text, PUBLIC_BASE_URL);
    })
  );

  it.effect("a visit keeps a patch alive, and it goes once the visits stop", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const { patchId } = yield* publish("Still visited");

      // Ten days left on the upload's window: this visit tops it up to thirty.
      yield* TestClock.adjust(80 * DAY);
      assert.strictEqual((yield* get(`/d/${patchId}`)).status, 200);

      // Day 95, past where the upload alone would have ended it, and visited again.
      yield* TestClock.adjust(15 * DAY);
      assert.strictEqual((yield* get(`/d/${patchId}`)).status, 200);

      // Thirty-one days without a visit, and both URLs are gone.
      yield* TestClock.adjust(31 * DAY);
      assert.strictEqual((yield* get(`/d/${patchId}`)).status, 404);
      assert.strictEqual((yield* get(`/d/${patchId}/v/1`)).status, 404);
    })
  );

  it.effect("serves the page when the visit top-up fails, without moving the clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const { patchId } = yield* publish("Survives a failed top-up");
      const sql = yield* SqlClient.SqlClient;
      // From here every move of a retention anchor fails inside the database.
      yield* sql.unsafe(`
        CREATE FUNCTION fail_visit() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'Forced visit top-up failure.'; END
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_visit BEFORE UPDATE OF expires_at ON patches
          FOR EACH ROW EXECUTE FUNCTION fail_visit();
      `);

      // Ten days left, so this visit is one the clock would move — and the
      // write throws. The reader still gets the page.
      yield* TestClock.adjust(80 * DAY);
      const served = yield* get(`/d/${patchId}`);
      assert.strictEqual(served.status, 200);
      assert.include(yield* served.text, "Survives a failed top-up");

      // Best-effort means exactly that: the clock genuinely did not move.
      yield* TestClock.adjust(11 * DAY);
      assert.strictEqual((yield* get(`/d/${patchId}`)).status, 404);
    })
  );
});

const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(routes);
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, PUBLIC_BASE_URL), options))
    )
  );
  return HttpServerResponse.toWeb(response);
});

it.layer(services)("pages in memory", (it) => {
  it.effect("keeps storage faults behind admission without disclosing a private patch", () =>
    Effect.gen(function* () {
      const { patchId, versionId } = yield* publish("Missing private bytes");
      yield* (yield* ContentStore.ContentStore).delete(Content.objectKey(patchId, versionId));
      const companies = yield* Companies.Companies;
      yield* companies.create({
        name: "Storage outsider",
        handle: "storage-outsider",
        clerkUserId: "user_storage_outsider",
        email: "storage@example.com",
        userName: "Outsider"
      });
      for (const headers of [
        {},
        {
          cookie: signedInCookies(
            signSession({ sub: "user_storage_outsider", email: "storage@example.com" })
          )
        }
      ]) {
        const response = yield* send(`/d/${patchId}`, { headers });
        const missing = yield* send("/d/notthere", { headers });
        assert.strictEqual(response.status, "cookie" in headers ? 404 : 401);
        assert.strictEqual(response.status, missing.status);
        assert.strictEqual(
          response.headers.get("cache-control"),
          missing.headers.get("cache-control")
        );
        assert.strictEqual(
          (yield* Effect.promise(() => response.text())).replaceAll(
            encodeURIComponent(`/d/${patchId}`),
            "PATCH"
          ),
          (yield* Effect.promise(() => missing.text())).replaceAll(
            encodeURIComponent("/d/notthere"),
            "PATCH"
          )
        );
      }
    })
  );

  it.effect("opens a company patch for an email sign-in with no display name", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("Email-only colleague");
      const response = yield* send(`/d/${patchId}`, {
        headers: { cookie: signedInCookies(signSession({ name: null })) }
      });
      assert.strictEqual(response.status, 200);
      assert.include(
        yield* Effect.promise(() => response.text()),
        "&lt;h1&gt;Email-only colleague&lt;/h1&gt;"
      );
    })
  );

  it.effect("uses the login template without disclosing whether a company patch exists", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("Hidden title");
      for (const path of [
        `/d/${patchId}`,
        `/d/${patchId}/v/1`,
        "/d/missingpatch",
        `/d/${patchId}/v/nope`
      ]) {
        const door = yield* send(path, { headers: { authorization: "Bearer patchy-dev-token" } });
        const login = yield* send(`/login?return=${encodeURIComponent(path)}`);
        assert.strictEqual(door.status, 401);
        assert.strictEqual(door.headers.get("cache-control"), "private, no-store");
        assert.isNull(door.headers.get("location"));
        assert.isNull(door.headers.get("www-authenticate"));
        const body = yield* Effect.promise(() => door.text());
        assert.strictEqual(body, yield* Effect.promise(() => login.text()));
        assert.notInclude(body, "Hidden title");
        assert.strictEqual((body.match(/<a /g) ?? []).length, 1);
        const target = new URL(door.headers.get("x-patchy-sign-in-url")!);
        assert.strictEqual(target.searchParams.get("redirect_url"), `${PUBLIC_BASE_URL}${path}`);
      }
    })
  );

  it.effect(
    "returns from a failed handshake to the patch without replaying handshake parameters",
    () =>
      Effect.gen(function* () {
        const path = "/d/missingpatch?view=chart";
        const handshake = signHandshake(["__session=; Max-Age=0; Path=/"]);
        const response = yield* send(`${path}&__clerk_handshake=${encodeURIComponent(handshake)}`);
        assert.strictEqual(response.status, 401);
        const signIn = new URL(response.headers.get("x-patchy-sign-in-url")!);
        assert.strictEqual(signIn.searchParams.get("redirect_url"), `${PUBLIC_BASE_URL}${path}`);
      })
  );

  it.effect(
    "confirms nothing across companies and sends unenrolled and deactivated viewers to their own pages",
    () =>
      Effect.gen(function* () {
        const { patchId } = yield* publish("Do not disclose");
        const companies = yield* Companies.Companies;
        yield* companies.create({
          name: "Other Company",
          handle: "other-memory",
          clerkUserId: "user_other",
          email: "other@example.com",
          userName: "Other"
        });
        const foreign = {
          cookie: signedInCookies(signSession({ sub: "user_other", email: "other@example.com" }))
        };
        const missing = yield* send("/d/missingpatch", { headers: foreign });
        const denied = yield* send(`/d/${patchId}`, { headers: foreign });
        assert.strictEqual(denied.status, 404);
        assert.strictEqual(missing.status, 404);
        assert.deepStrictEqual([...denied.headers], [...missing.headers]);
        assert.strictEqual(
          yield* Effect.promise(() => denied.text()),
          yield* Effect.promise(() => missing.text())
        );
        const unenrolled = yield* send(`/d/${patchId}`, {
          headers: {
            cookie: signedInCookies(signSession({ sub: "user_new", email: "new@example.com" }))
          }
        });
        assert.strictEqual(unenrolled.status, 303);
        assert.strictEqual(
          unenrolled.headers.get("location"),
          `/join?return=${encodeURIComponent(`/d/${patchId}`)}`
        );
        const invitation = yield* companies.createInvite({
          companyId: DEV_SEED.companyId,
          invitedBy: DEV_SEED.userId,
          email: "inactive@example.com"
        });
        const inactive = yield* companies.consumeInvite({
          inviteId: invitation.id,
          clerkUserId: "user_inactive",
          email: "inactive@example.com",
          name: "Inactive"
        });
        yield* (yield* Users.Users).deactivate({
          companyId: DEV_SEED.companyId,
          userId: inactive.id
        });
        const deactivated = yield* send(`/d/${patchId}`, {
          headers: {
            cookie: signedInCookies(
              signSession({ sub: "user_inactive", email: "inactive@example.com" })
            )
          }
        });
        assert.strictEqual(deactivated.status, 403);
        assert.include(
          yield* Effect.promise(() => deactivated.text()),
          "Your account is deactivated"
        );
        assert.strictEqual(deactivated.headers.get("cache-control"), "private, no-store");
      })
  );

  it.effect(
    "switches both URL shapes between public and session shells without changing the sandbox",
    () =>
      Effect.gen(function* () {
        const { patchId } = yield* publish("Sharing boundary");
        const sql = yield* SqlClient.SqlClient;
        for (const scope of ["company", "public", "company"]) {
          yield* sql`UPDATE patches SET scope = ${scope} WHERE id = ${patchId}`;
          for (const path of [`/d/${patchId}`, `/d/${patchId}/v/1`]) {
            const response = yield* send(path, { headers: { cookie: signedInCookies() } });
            assert.strictEqual(response.status, 200);
            const body = yield* Effect.promise(() => response.text());
            assert.include(body, 'sandbox=""');
            assert.include(body, "&lt;h1&gt;Sharing boundary&lt;/h1&gt;");
            if (scope === "public") {
              assert.strictEqual(response.headers.get("cache-control"), "public, max-age=60");
              assert.strictEqual(response.headers.get("content-security-policy"), CSP);
              assert.notInclude(body, "<script");
              assert.deepStrictEqual(response.headers.getSetCookie(), []);
            } else {
              assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
              assert.strictEqual(
                response.headers.get("content-security-policy"),
                `${CSP}; script-src 'self' https://${FRONTEND_API_HOST}; connect-src https://${FRONTEND_API_HOST}`
              );
              assert.include(
                body,
                `src="https://${FRONTEND_API_HOST}/npm/@clerk/clerk-js@5/dist/clerk.headless.browser.js"`
              );
              assert.include(body, 'src="/auth/session.js"');
              assert.strictEqual((body.match(/<script\b/g) ?? []).length, 2);
              assert.notMatch(body, /<script\b[^>]*>[^<]+<\/script>/);
              assert.strictEqual((yield* send(path)).status, 401);
            }
          }
        }
      })
  );
});
