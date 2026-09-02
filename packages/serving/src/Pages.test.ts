import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ClerkSession, migrations as authMigrations, PrototypeUsers } from "@patchy/auth";
import { clerkEnv, seedDevAccount, signedInNow } from "@patchy/auth/testing";
import { ContentStore } from "@patchy/content-store";
import { Content, migrations as patchesMigrations, Patches } from "@patchy/patches";
import * as Testing from "@patchy/sql/testing";
import * as Pages from "./Pages.js";
import { servingHeaders } from "./serving-headers.js";

const DAY = 24 * 60 * 60 * 1000;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
  "frame-src 'self' about:; base-uri 'none'; form-action 'none'";

/**
 * A principal and a token to hold patches; the pages never look at either.
 * PROTOTYPE for #119: the door's just-in-time user row joins `acct_dev`.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO accounts (id, name) VALUES ('acct_pages', 'Pages')`;
  yield* sql`INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
    VALUES ('tok_pages', 'acct_pages', 'Pages token', 'hash:tok_pages', '["upload"]'::jsonb)`;
  yield* seedDevAccount;
});

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

/**
 * The pages behind the serving headers, on a real socket, over a fresh
 * database. PROTOTYPE for #119: the doored routes need the door's two
 * services, and the offline instance's keys come through the config, as
 * they do in production.
 */
const layer = HttpRouter.serve(
  Layer.mergeAll(
    Pages.layer.pipe(Layer.provide([ClerkSession.layer, PrototypeUsers.layer])),
    HttpRouter.middleware(servingHeaders, { global: true })
  ),
  { disableLogger: true, disableListenLog: true }
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(Content.layer),
  Layer.provideMerge(Layer.mergeAll(Patches.layer, memoryStore)),
  Layer.provideMerge(Layer.effectDiscard(seed)),
  Layer.provideMerge(Testing.layer({ ...authMigrations, ...patchesMigrations })),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv("test"))))
);

/** A signed-in reader's document request: the door in front of `/d/*` wants both. */
const get = (url: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({ cookie: signedInNow(), accept: "text/html", ...headers })
      )
    )
  );

const publish = (title: string) =>
  Effect.flatMap(Content.Content, (content) =>
    content.upload({
      patchId: null,
      accountId: "acct_pages",
      apiTokenId: "tok_pages",
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
  it.effect("serves a patch noindexed, unwatched, locked down and private behind the door", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("Serving Guarantees");
      // PROTOTYPE for #119: behind the door every served patch is private and
      // uncached, whatever URL shape named it. An API bearer would be read as a
      // Clerk session token and refused, so none is sent.
      for (const url of [`/d/${patchId}`, `/d/${patchId}/v/1`]) {
        const response = yield* get(url);
        assert.strictEqual(response.status, 200, url);
        assert.strictEqual(response.headers["x-robots-tag"], "noindex");
        assert.strictEqual(response.headers["referrer-policy"], "no-referrer");
        assert.strictEqual(response.headers["content-security-policy"], CSP);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
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
        // PROTOTYPE for #119: the door marks everything it lets through private.
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
      assert.include(yield* (yield* get("/")).text, "https://patchy.example");
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
