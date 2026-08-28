/**
 * The copyable test patterns: `it.layer` sharing one migrated Postgres per
 * block, `HttpApiTest` for API routes, `NodeHttpServer.layerTest` for the
 * headers a real socket sees, `TestClock` for the mutable clock.
 */
import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { sha256 } from "@patchy/core";
import { DateTime, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiMiddleware, HttpApiTest } from "effect/unstable/httpapi";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Authorization, PatchyApi } from "./api.js";
import { AuthorizationLive } from "./auth/index.js";
import { Patches } from "./patches/index.js";
import { allMigrations, legacyMigrations, pgLayerFor, runMigrations } from "./sql.js";
import { AppRoutes, DRAFT_CONTENT_SECURITY_POLICY, MeHandlers } from "./server.js";
import { createEmptyPostgresDatabase } from "../../../test/postgres.js";

/** A fresh empty database, migrated by the given record through the slice's Migrator, dropped with the layer. */
const migratedPg = (migrations: Parameters<typeof runMigrations>[0]) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(
        Effect.promise(createEmptyPostgresDatabase),
        (database) => Effect.promise(database.drop)
      );
      return Layer.effectDiscard(runMigrations(migrations)).pipe(
        Layer.provideMerge(pgLayerFor(database.connectionString))
      );
    })
  );

const MigratedPg = migratedPg(allMigrations);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO accounts (id, name) VALUES ('acct_bootstrap', 'Bootstrap Account')`;
  yield* sql`INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
    VALUES ('tok_bootstrap', 'acct_bootstrap', 'Bootstrap API Token', ${sha256("dev-token")}, '["admin","upload"]'::jsonb)`;
  yield* sql`INSERT INTO drafts (id, account_id, title) VALUES ('d_1', 'acct_bootstrap', 'Hello')`;
  yield* sql`INSERT INTO draft_versions (id, draft_id, version_number, object_key) VALUES ('v_1', 'd_1', 1, 'objects/one.html')`;
  yield* sql`UPDATE drafts SET current_version_id = 'v_1' WHERE id = 'd_1'`;
});

/** Seeded during layer construction, so no test depends on another having run. */
const SeededPg = Layer.effectDiscard(seed).pipe(Layer.provideMerge(MigratedPg));

const bearer = (token: string) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token))
  );

it.layer(MigratedPg)("Migrator across packages", (it) => {
  it.effect("applies both packages' migrations in id order, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const applied =
        yield* sql`SELECT migration_id AS id, name FROM schema_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(applied, [
        { id: 1, name: "accounts" },
        { id: 2, name: "api_tokens" },
        { id: 3, name: "drafts" },
        { id: 4, name: "draft_versions" }
      ]);
      const again = yield* runMigrations(allMigrations);
      assert.deepStrictEqual(again, []);
    })
  );

  it.effect("refuses a duplicate id from another package", () =>
    Effect.gen(function* () {
      const error = yield* runMigrations({
        ...allMigrations,
        "0003_drafts_again": allMigrations["0003_drafts"]
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MigrationError");
      assert.strictEqual((error as { kind: string }).kind, "Duplicates");
    })
  );
});

it.layer(migratedPg(legacyMigrations))("Migrator over today's SCHEMA_MIGRATIONS", (it) => {
  it.effect("runs every multi-statement DDL step and lands the current schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const applied =
        yield* sql`SELECT migration_id AS id FROM schema_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        applied.map((row) => row.id),
        [1, 2, 3, 4, 5, 6]
      );
      const columns =
        yield* sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'drafts' ORDER BY column_name`;
      assert.include(
        columns.map((row) => row.column_name),
        "expires_at"
      );
      assert.include(
        columns.map((row) => row.column_name),
        "pinned_at"
      );
    })
  );
});

it.layer(
  Layer.mergeAll(MeHandlers, HttpServer.layerServices).pipe(
    Layer.provideMerge(AuthorizationLive),
    Layer.provideMerge(SeededPg)
  )
)("GET /api/me through HttpApiTest", (it) => {
  it.effect("returns the identity for a live token", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(PatchyApi, ["me"]);
      const identity = yield* client.me();
      assert.deepStrictEqual(
        { ...identity },
        {
          accountId: "acct_bootstrap",
          accountName: "Bootstrap Account",
          apiTokenId: "tok_bootstrap",
          apiTokenName: "Bootstrap API Token",
          scopes: ["admin", "upload"]
        }
      );
    }).pipe(Effect.provide(bearer("dev-token")))
  );

  it.effect("401s an unknown token", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(PatchyApi, ["me"]);
      const error = yield* client.me().pipe(Effect.flip);
      assert.deepStrictEqual(error, { ok: false, error: "Missing or invalid API token." });
    }).pipe(Effect.provide(bearer("nope")))
  );
});

const ServedApp = HttpRouter.serve(AppRoutes).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(Patches.layer),
  Layer.provideMerge(SeededPg)
);

const LastVisited = Schema.Struct({ lastVisitedAt: Schema.NullOr(Schema.Date) });

it.layer(ServedApp)("GET /d/:draftId over a real socket", (it) => {
  it.effect("serves the draft with the serving headers", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/d/d_1");
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["x-robots-tag"], "noindex");
      assert.strictEqual(response.headers["referrer-policy"], "no-referrer");
      assert.strictEqual(
        response.headers["content-security-policy"],
        DRAFT_CONTENT_SECURITY_POLICY
      );
      assert.strictEqual(response.headers["cache-control"], "public, max-age=60");
      assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
      assert.include(yield* response.text, "<title>Patchy draft</title>");
    })
  );

  it.effect("404s an unknown draft, uncached", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/d/missing");
      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.headers["cache-control"], "no-store");
      assert.strictEqual(response.headers["x-robots-tag"], "noindex");
    })
  );

  it.effect("/api/me over the socket is no-store and nosniff", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get("/api/me").pipe(HttpClientRequest.bearerToken("dev-token"))
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["cache-control"], "no-store");
      assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
    })
  );

  it.effect("/api/me with a bad token is today's 401 body", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get("/api/me").pipe(HttpClientRequest.bearerToken("nope"))
      );
      assert.strictEqual(response.status, 401);
      assert.deepStrictEqual(yield* response.json, {
        ok: false,
        error: "Missing or invalid API token."
      });
    })
  );

  it.effect("a served page records its visit at the test clock's time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-02T03:04:05Z")));
      const client = yield* HttpClient.HttpClient;
      yield* client.get("/d/d_1");
      const sql = yield* SqlClient.SqlClient;
      const read = SqlSchema.findOne({
        Request: Schema.String,
        Result: LastVisited,
        execute: (id) => sql`SELECT last_visited_at AS "lastVisitedAt" FROM drafts WHERE id = ${id}`
      });
      const row = yield* read("d_1");
      assert.strictEqual(row.lastVisitedAt?.toISOString(), "2030-01-02T03:04:05.000Z");
    })
  );
});
