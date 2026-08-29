/**
 * The server booted whole, as `start.ts` boots it: one upload goes in through
 * the API and comes out as a served page, with the headers a socket sees.
 * What each route does is its package's test; this proves the wiring.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { answer, DEV_TOKEN, html, send, server, upload } from "./test/server.js";

it.layer(
  server({ PATCHY_PUBLIC_BASE_URL: "https://patchy.example", PATCHY_TRUST_PROXY: "127.0.0.1" })
)("the server, booted whole", (it) => {
  it.effect("answers health and the API, uncached", () =>
    Effect.gen(function* () {
      const health = yield* send(HttpClientRequest.get("/healthz"));
      assert.deepStrictEqual(yield* answer(health), { status: 200, body: { ok: true } });
      assert.strictEqual(health.headers["cache-control"], "no-store");
      assert.strictEqual(health.headers["x-content-type-options"], "nosniff");

      const me = yield* send(
        HttpClientRequest.get("/api/me").pipe(HttpClientRequest.bearerToken(DEV_TOKEN))
      );
      assert.strictEqual(me.status, 200);
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
          HttpClientRequest.bearerToken(DEV_TOKEN),
          HttpClientRequest.setHeader("x-forwarded-for", "203.0.113.9, 198.51.100.7"),
          HttpClientRequest.bodyJsonUnsafe({ html: html("Booted") })
        )
      );
      const body = (yield* created.json) as { patchId: string; publicUrl: string };
      assert.strictEqual(created.status, 201);
      assert.strictEqual(body.publicUrl, `https://patchy.example/d/${body.patchId}`);

      const page = yield* send(HttpClientRequest.get(`/d/${body.patchId}`));
      assert.strictEqual(page.status, 200);
      assert.strictEqual(page.headers["x-robots-tag"], "noindex");
      assert.strictEqual(page.headers["cache-control"], "public, max-age=60");
      assert.include(yield* page.text, "Booted");

      // The socket is the trusted proxy, so the rightmost address it did not
      // add is the client's — and that is what the version records.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ source_ip: string }>`SELECT source_ip FROM patch_versions`;
      assert.deepStrictEqual(rows, [{ source_ip: "198.51.100.7" }]);

      // A direct request records the socket's own address, whatever it claims.
      const direct = yield* upload(DEV_TOKEN, { html: html("Direct") });
      assert.strictEqual(direct.status, 201);
      const [, second] = yield* sql<{ source_ip: string }>`
          SELECT source_ip FROM patch_versions ORDER BY created_at`;
      // Dual-stack in the test; the address family is the socket's business.
      assert.match(second?.source_ip ?? "", /(^|:)127\.0\.0\.1$/);
    })
  );
});
