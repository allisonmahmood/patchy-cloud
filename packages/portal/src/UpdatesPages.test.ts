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
        const document = JSON.stringify({ version: 1, entries: [entry(1), entry(3), entry(2)] });
        yield* store.put(updates.objectKey, document);
        for (const path of ["/updates", "/updates/latest"]) {
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
  assert.include(html, '<details class="update-entry" id="update-1"><summary>');
});
