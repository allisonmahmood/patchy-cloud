import { assert, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import * as Testing from "@patchy/company-database/testing";
import * as UpdatesPages from "./UpdatesPages.js";
import * as updates from "./updates.js";

const storage = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-updates-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: dir })))
    );
  })
).pipe(Layer.provide(NodeFileSystem.layer));
const services = Layer.mergeAll(Session.layer, Companies.layer, Users.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(Testing.resourceChangesLayer),
  Layer.provideMerge(storage),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const request = Effect.fn(function* (path: string, user?: string) {
  const app = yield* HttpRouter.toHttpEffect(UpdatesPages.layer);
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(new URL(path, PUBLIC_BASE_URL), {
          headers: user
            ? {
                cookie: signedInCookies(
                  signSession({ sub: user, email: `${user}@patchy.local`, name: user })
                )
              }
            : {}
        })
      )
    )
  );
  return HttpServerResponse.toWeb(response);
});
const entry = (sequence: number): updates.Entry => ({
  sequence,
  publishedAt: "2026-10-05T12:00:00.000Z",
  title: `Update ${sequence}`,
  summary: "Changes for everyone",
  changes: [{ kind: "New", title: "Shared notes", detail: "One history" }]
});

it.layer(services)("shared deployment updates", (it) => {
  it.effect(
    "requires a session and shares one document across companies without a read-state write",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const id of ["updates_a", "updates_b"]) {
          yield* sql`INSERT INTO companies (id, handle, name) VALUES (${id}, ${id.replace("_", "-")}, ${id})`;
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role) VALUES (${id}, ${id}, ${id}, ${`${id}@patchy.local`}, ${id}, 'member')`;
        }
        const store = yield* ContentStore.ContentStore;
        const document = JSON.stringify({
          version: 1,
          entries: [
            {
              ...entry(1),
              deployment: {
                runId: 123,
                attempt: 1,
                commit: "a".repeat(40),
                url: "https://github.com/allisonmahmood/patchy-cloud/actions/runs/123/attempts/1"
              }
            },
            entry(3),
            entry(2)
          ]
        });
        yield* store.put(updates.objectKey, document);
        for (const path of ["/updates", "/updates/latest", "/updates/feed"]) {
          assert.strictEqual((yield* request(path)).status, 401);
        }
        for (const user of ["updates_a", "updates_b"]) {
          const latest = yield* request("/updates/latest", user);
          assert.strictEqual(latest.status, 200);
          assert.strictEqual(latest.headers.get("cache-control"), "private, no-store");
          assert.deepStrictEqual(yield* Effect.promise(() => latest.json()), {
            viewerId: user,
            latest: entry(3)
          });
          const feed = yield* request("/updates/feed", user);
          assert.strictEqual(feed.status, 200);
          assert.strictEqual(feed.headers.get("cache-control"), "private, no-store");
          assert.deepStrictEqual(yield* Effect.promise(() => feed.json()), {
            viewerId: user,
            entries: [3, 2, 1].map((sequence) => {
              const { publishedAt, title, summary } = entry(sequence);
              return { sequence, publishedAt, title, summary };
            })
          });
          const page = yield* request("/updates", user);
          const html = yield* Effect.promise(() => page.text());
          assert.include(html, 'data-updates-through="3"');
          assert.isBelow(html.indexOf('id="update-3"'), html.indexOf('id="update-2"'));
          assert.isBelow(html.indexOf('id="update-2"'), html.indexOf('id="update-1"'));
          assert.include(html, `data-viewer-id="${user}"`);
          assert.include(html, 'src="/updates/client.js"');
          assert.include(page.headers.get("content-security-policy")!, "connect-src 'self'");
        }
        assert.strictEqual(yield* store.get(updates.objectKey), document);
      })
  );

  it.effect("distinguishes an empty history from an unavailable or invalid document", () =>
    Effect.gen(function* () {
      const store = yield* ContentStore.ContentStore;
      yield* store.delete(updates.objectKey);
      assert.deepStrictEqual(yield* updates.read, []);
      yield* store.put(updates.objectKey, "broken document");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name) VALUES ('updates_empty', 'updates-empty', 'Empty')`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role) VALUES ('updates_empty', 'updates_empty', 'updates_empty', 'updates_empty@patchy.local', 'Empty', 'member')`;
      const response = yield* request("/updates", "updates_empty");
      assert.strictEqual(response.status, 503);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, "Updates are unavailable");
      assert.notInclude(html, "data-updates-through");
      assert.strictEqual((yield* request("/updates/latest", "updates_empty")).status, 503);
      assert.strictEqual((yield* request("/updates/feed", "updates_empty")).status, 503);
      yield* store.put(
        updates.objectKey,
        JSON.stringify({ version: 1, entries: [entry(1), entry(1)] })
      );
      assert.strictEqual((yield* updates.read.pipe(Effect.flip))._tag, "SchemaError");
    })
  );
});

it("escapes notes and keeps native expandable entries", () => {
  const html = updates.render([
    {
      ...entry(1),
      title: '<script>alert("title")</script>',
      summary: '<img src=x onerror="alert(1)">',
      changes: [{ kind: "Fixed", title: "<b>title</b>", detail: "<script>body</script>" }]
    }
  ]);
  assert.notMatch(html, /<(script|img|b)\b/);
  assert.include(html, "&lt;script&gt;");
  assert.include(
    html,
    '<details class="update-entry" id="update-1" data-update-sequence="1"><summary>'
  );
});

it.effect("keeps Deploy Action provenance internal and rejects a non-GitHub source link", () =>
  Effect.gen(function* () {
    const deployment = {
      runId: 37378674715,
      attempt: 1,
      commit: "a".repeat(40),
      url: "https://github.com/allisonmahmood/patchy-cloud/actions/runs/37378674715/attempts/1"
    };
    const history = (url: string) =>
      JSON.stringify({
        version: 1,
        entries: [{ ...entry(1), deployment: { ...deployment, url } }]
      });
    const decoded = yield* updates.decodeHistory(history(deployment.url));
    assert.notInclude(updates.render(decoded.entries), deployment.url);
    assert.notInclude(updates.render(decoded.entries), "GitHub");
    assert.strictEqual(
      (yield* updates.decodeHistory(history("javascript:alert(1)")).pipe(Effect.flip))._tag,
      "SchemaError"
    );
  })
);

it("pages history ten entries at a time and locates older bell links", () => {
  const entries = Array.from({ length: 23 }, (_, index) => entry(23 - index));
  assert.deepStrictEqual(
    updates.paginate(entries).entries.map((entry) => entry.sequence),
    [23, 22, 21, 20, 19, 18, 17, 16, 15, 14]
  );
  assert.deepStrictEqual(
    updates.paginate(entries, { page: "2" }).entries.map((entry) => entry.sequence),
    [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]
  );
  assert.deepStrictEqual(
    updates.paginate(entries, { page: "999" }).entries.map((entry) => entry.sequence),
    [3, 2, 1]
  );
  for (const page of ["0", "-1", "1.5", "NaN", "9007199254740992"])
    assert.strictEqual(updates.paginate(entries, { page }).page, 1);
  assert.strictEqual(updates.paginate(entries, { page: "3", release: "13" }).page, 2);
  assert.strictEqual(updates.paginate([], { page: "2" }).page, 1);
  assert.notInclude(updates.render(entries, { page: "2" }), ">Latest</span>");
  assert.include(updates.render(entries, { page: "2" }), 'aria-current="page" aria-label="Page 2"');
  assert.notInclude(updates.render(entries.slice(0, 10)), 'aria-label="Update history pages"');
  assert.include(updates.render([]), "No updates published yet.");
});
