import { randomUUID } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CURRENT_RELEASE, MANIFEST_VERSION, WIRE_VERSION, type Manifest } from "@patchy/api";
import { AuthPages, DeviceLogins, MachineTokens, Session } from "@patchy/auth";
import { Analytics } from "@patchy/analytics";
import { Limits } from "@patchy/limits";
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
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { ddl } from "@patchy/sql";
import * as Testing from "@patchy/company-database/testing";
import { Tables } from "@patchy/primitives";
import * as Pages from "./Pages.js";
import { servingHeaders } from "./serving-headers.js";

const DAY = 24 * 60 * 60 * 1000;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
  "frame-src 'self' about:; base-uri 'none'; form-action 'none'";

const memoryStore = Layer.sync(ContentStore.ContentStore, () => {
  const objects = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  return ContentStore.ContentStore.of({
    list: (prefix) =>
      Stream.suspend(() =>
        Stream.fromIterable(
          [...objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, object]) => ({ key, lastModified: object.lastModified }))
        )
      ),
    put: Effect.fn(function* (key, html) {
      objects.set(key, {
        bytes: new TextEncoder().encode(html),
        lastModified: yield* Clock.currentTimeMillis
      });
    }),
    get: (key) =>
      Effect.suspend(() => {
        const bytes = objects.get(key)?.bytes;
        return bytes === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
      }),
    putBytes: Effect.fn(function* (key, bytes) {
      objects.set(key, { bytes: bytes.slice(), lastModified: yield* Clock.currentTimeMillis });
    }),
    getBytes: (key) =>
      Effect.suspend(() => {
        const bytes = objects.get(key)?.bytes;
        return bytes === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(bytes.slice());
      }),
    delete: (key) => Effect.sync(() => void objects.delete(key))
  });
});

const routes = Layer.mergeAll(
  Pages.layer,
  AuthPages.layer,
  HttpRouter.add("*", "/*", Pages.notFound),
  HttpRouter.middleware(servingHeaders, { global: true })
);
const services = Layer.mergeAll(Content.layer, DeviceLogins.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Patches.layer,
      memoryStore,
      Session.layer,
      Companies.layer,
      Users.layer,
      MachineTokens.layer,
      Analytics.layerNoop,
      Limits.layer,
      InviteMail.layerRecording
    )
  ),
  Layer.provideMerge(ConnectionStoreDev.layer([])),
  Layer.provideMerge(Tables.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
/** The same routes and services in memory and on a real socket. */
const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
);

const get = (url: string, headers: Record<string, string> = { cookie: signedInCookies() }) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
  );

const publish = (
  title: string,
  scope?: Patches.Patch["scope"],
  patchId: string | null = null,
  name?: string,
  definitions?: Pick<typeof Manifest.Type, "tables" | "uses">
) =>
  Effect.flatMap(Content.Content, (content) =>
    content
      .publish({
        manifest: {
          manifestVersion: MANIFEST_VERSION,
          release: CURRENT_RELEASE,
          tier: 0,
          ...(name === undefined ? {} : { name }),
          tables: {},
          files: {},
          uses: {},
          ...definitions
        },
        publishKey: randomUUID(),
        payloadDigest: title,
        wireVersion: WIRE_VERSION,
        publicBaseUrl: PUBLIC_BASE_URL,
        warnings: [],
        patchId,
        companyId: DEV_SEED.companyId,
        ownerUserId: DEV_SEED.userId,
        machineTokenId: DEV_SEED.tokenId,
        title,
        ...(scope === undefined ? {} : { scope }),
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
      .pipe(Effect.map((result) => ({ ...result, path: new URL(result.address).pathname })))
  );

it.layer(layer)("pages", (it) => {
  it.effect(
    "shows off notices only to active colleagues and limits Restore to owner or admin",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const sql = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const ownerId = "usr_notice_owner";
        const memberId = "usr_notice_member";
        for (const [id, name] of [
          [ownerId, "Priya"],
          [memberId, "Alex"]
        ] as const) {
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES (${id}, ${id}, ${DEV_SEED.companyId}, ${`${id}@example.com`}, ${name}, 'member')`;
        }
        yield* (yield* Companies.Companies).create({
          name: "Notice outsider",
          handle: "notice-outsider",
          clerkUserId: "user_notice_outsider",
          email: "outsider@example.com",
          userName: "Outsider"
        });
        const people = [
          {
            cookie: signedInCookies(
              signSession({ sub: ownerId, email: `${ownerId}@example.com`, name: "Priya" })
            ),
            manage: true
          },
          { cookie: signedInCookies(), manage: true },
          {
            cookie: signedInCookies(
              signSession({ sub: memberId, email: `${memberId}@example.com`, name: "Alex" })
            ),
            manage: false
          }
        ];
        const foreign = {
          cookie: signedInCookies(
            signSession({ sub: "user_notice_outsider", email: "outsider@example.com" })
          )
        };
        const patch = yield* publish("Hidden patch content", "public", null, "notice-patch");
        const latest = yield* publish("Latest hidden content", undefined, patch.patchId);
        yield* patches.reassign(patch.patchId, { userId: DEV_SEED.userId, admin: true }, ownerId);
        const actor = { userId: ownerId, admin: false };
        const paths = [
          patch.path,
          `${patch.path}/~v/1`,
          `/~content/${patch.patchId}/${patch.versionId}`,
          `${patch.path}/~v/2`,
          `/~content/${patch.patchId}/${latest.versionId}`
        ];
        for (const state of ["retired", "deleted"] as const) {
          if (state === "retired") yield* patches.retire(patch.patchId, actor);
          else yield* patches.delete(patch.patchId, actor);
          yield* TestClock.adjust(12 * DAY);
          for (const path of paths) {
            for (const person of people) {
              const response = yield* get(path, { cookie: person.cookie });
              assert.strictEqual(response.status, 200, path);
              assert.strictEqual(response.headers["cache-control"], "private, no-store");
              assert.strictEqual(response.headers["referrer-policy"], "same-origin");
              assert.include(response.headers["content-security-policy"], "form-action 'self'");
              assert.include(response.headers["content-security-policy"], "frame-ancestors 'none'");
              const html = yield* response.text;
              assert.include(html, 'aria-label="Primary"');
              assert.include(html, 'href="/patches/notice-patch"');
              assert.include(html, `${state === "retired" ? "Retired" : "Deleted"} by Priya`);
              assert.include(
                html,
                `datetime="2026-01-${state === "retired" ? "01" : "13"}T00:00:00.000Z"`
              );
              assert.notInclude(html, "<iframe");
              assert.notInclude(html, "Hidden patch content");
              assert.notInclude(html, "Latest hidden content");
              assert.strictEqual(
                html.includes('action="/patches/notice-patch/restore"'),
                person.manage
              );
              if (person.manage) assert.include(html, `name="expectedState" value="${state}"`);
              if (state === "deleted") assert.include(html, "Gone for good in 18 days");
            }
            const door = yield* get(path, {});
            assert.strictEqual(door.status, 401);
            assert.strictEqual(door.headers["cache-control"], "private, no-store");
            assert.include(yield* door.text, ">Sign in</a>");
            const denied = yield* get(path, foreign);
            assert.strictEqual(denied.status, 404);
            assert.strictEqual(denied.headers["cache-control"], "private, no-store");
            assert.notInclude(yield* denied.text, "notice-patch");
          }
        }
        yield* TestClock.adjust(18 * DAY);
        const expired = yield* get(patch.path);
        const expiredHtml = yield* expired.text;
        assert.include(expiredHtml, "Gone for good in 0 days");
        assert.notInclude(expiredHtml, 'action="/patches/notice-patch/restore"');
        yield* patches.purgeDeleted(patch.patchId);
        for (const path of paths) {
          for (const headers of [{}, foreign, { cookie: people[0]!.cookie }]) {
            assert.strictEqual((yield* get(path, headers)).status, 404);
          }
        }
        const disabled = yield* publish("Disabled content", "public", null, "disabled-notice");
        yield* patches.retire(disabled.patchId, { userId: DEV_SEED.userId, admin: false });
        yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${disabled.patchId}`;
        for (const path of [
          disabled.path,
          `${disabled.path}/~v/1`,
          `/~content/${disabled.patchId}/${disabled.versionId}`
        ]) {
          for (const headers of [{}, foreign, { cookie: signedInCookies() }]) {
            assert.strictEqual((yield* get(path, headers)).status, 404);
          }
        }
      })
  );

  it.effect(
    "chooses restore confirmation from the current version's sources even at historical URLs",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const actor = { userId: DEV_SEED.userId, admin: false };
        const source = yield* publish("Notice source", undefined, null, "notice-source", {
          tables: {
            notes: {
              description: "Notes",
              columns: { body: { kind: "text" } },
              indexes: {},
              shared: true
            }
          },
          uses: {}
        });
        const consumer = yield* publish("Notice consumer", undefined, null, "notice-consumer", {
          tables: {},
          uses: {
            source: {
              kind: "sharedTable",
              patchId: source.patchId,
              table: "notes",
              id: `${source.patchId}/notes`,
              revision: 1
            }
          }
        });
        yield* publish("No current sources", undefined, consumer.patchId, "notice-consumer");
        yield* patches.retire(source.patchId, actor, true);
        yield* patches.retire(consumer.patchId, actor);
        const paths = [
          consumer.path,
          `${consumer.path}/~v/1`,
          `/~content/${consumer.patchId}/${consumer.versionId}`
        ];
        for (const path of paths) {
          const html = yield* (yield* get(path)).text;
          assert.include(html, 'action="/patches/notice-consumer/restore"');
        }
        yield* patches.restore(consumer.patchId, actor);
        yield* patches.rollback(consumer.patchId, actor, 1);
        yield* patches.retire(consumer.patchId, actor);
        for (const path of paths) {
          const html = yield* (yield* get(path)).text;
          assert.include(html, 'href="/patches/notice-consumer/restore"');
          assert.notInclude(html, 'action="/patches/notice-consumer/restore"');
        }
      })
  );

  it.effect("keeps company patches behind the login door without accepting machine tokens", () =>
    Effect.gen(function* () {
      const { path, patchId, versionId } = yield* publish("Company only");
      for (const url of [path, `/~content/${patchId}/${versionId}`]) {
        const response = yield* get(url, {
          authorization: "Bearer patchy-dev-token",
          cookie: ""
        });
        assert.strictEqual(response.status, 401);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        assert.isUndefined(response.headers.location);
        assert.isUndefined(response.headers["www-authenticate"]);
        assert.include(yield* response.text, ">Sign in</a>");
      }
    })
  );

  it.effect(
    "serves only a public patch's current version publicly at addresses and content URLs",
    () =>
      Effect.gen(function* () {
        const { patchId, path, versionId: olderVersionId } = yield* publish("Company-only history");
        const current = yield* publish("Serving Guarantees", undefined, patchId);
        yield* (yield* Patches.Patches).setScope(
          patchId,
          { userId: DEV_SEED.userId, admin: false },
          "public"
        );
        for (const [url, content] of [
          [path, false],
          [`${path}/~v/2`, false],
          [`/~content/${patchId}/${current.versionId}`, true]
        ] as const) {
          // Invalid credentials never turn a public page into a challenge.
          const response = yield* get(url, {
            authorization: "Bearer not-a-real-token",
            cookie: "session=whatever"
          });
          assert.strictEqual(response.status, 200, url);
          assert.strictEqual(response.headers["x-robots-tag"], "noindex");
          assert.strictEqual(response.headers["referrer-policy"], "no-referrer");
          assert.strictEqual(
            response.headers["content-security-policy"],
            content ? `sandbox; ${CSP}; frame-ancestors 'self'` : `${CSP}; frame-ancestors 'none'`
          );
          assert.strictEqual(response.headers["cache-control"], "public, max-age=60");
          assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
          assert.isUndefined(response.headers["set-cookie"]);
          assert.isUndefined(response.headers["www-authenticate"]);
          const body = yield* response.text;
          assert.include(body, "Serving Guarantees");
          if (content) {
            assert.strictEqual(response.headers["content-type"], "text/html; charset=utf-8");
            assert.strictEqual(
              body,
              "<!doctype html><html><head><title>Serving Guarantees</title></head><body><h1>Serving Guarantees</h1></body></html>"
            );
            assert.strictEqual(
              response.headers["permissions-policy"],
              "camera=(), microphone=(), geolocation=()"
            );
          } else {
            assert.include(body, 'class="patch-frame"');
            assert.include(body, "&lt;h1&gt;Serving Guarantees&lt;/h1&gt;");
          }
          assert.notInclude(body, "<script");
          assert.notInclude(body, "<form");
        }

        for (const url of [`${path}/~v/1`, `/~content/${patchId}/${olderVersionId}`]) {
          const older = yield* get(url, {});
          assert.strictEqual(older.status, 401);
          assert.strictEqual(older.headers["cache-control"], "private, no-store");
          const door = yield* older.text;
          assert.include(door, ">Sign in</a>");
          assert.notInclude(door, "Company-only history");

          const colleague = yield* get(url);
          assert.strictEqual(colleague.status, 200);
          assert.strictEqual(colleague.headers["cache-control"], "private, no-store");
          const history = yield* colleague.text;
          assert.include(history, "Company-only history");
        }
        // Content must use its stored version's tier, not the current tier-zero version.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE patch_versions SET tier = 1 WHERE id = ${olderVersionId}`;
        const scriptedHistory = yield* get(`/~content/${patchId}/${olderVersionId}`);
        assert.strictEqual(
          scriptedHistory.headers["content-security-policy"],
          "sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-ancestors 'self'"
        );
        assert.strictEqual(
          scriptedHistory.headers["permissions-policy"],
          "camera=(), microphone=(), geolocation=()"
        );
        assert.strictEqual(
          yield* scriptedHistory.text,
          "<!doctype html><html><head><title>Company-only history</title></head><body><h1>Company-only history</h1></body></html>"
        );
      })
  );

  it.effect("reclaims renamed addresses permanently without opening the privacy door", () =>
    Effect.gen(function* () {
      yield* (yield* Companies.Companies).create({
        name: "Alias outsider",
        handle: "alias-outsider",
        clerkUserId: "user_alias_outsider",
        email: "alias-outsider@example.com",
        userName: "Outsider"
      });
      const foreign = {
        cookie: signedInCookies(
          signSession({ sub: "user_alias_outsider", email: "alias-outsider@example.com" })
        )
      };
      const patches = yield* Patches.Patches;
      const suffixes = ["", "/~v/1/reports/weekly?view=chart&tag=first%20item&tag=second"];
      for (const scope of ["company", "public"] as const) {
        const oldName = `${scope}-brief`;
        const newName = `${scope}-renamed-brief`;
        const oldPath = `/${DEV_SEED.companyHandle}/${oldName}`;
        const newPath = `/${DEV_SEED.companyHandle}/${newName}`;
        const originalTitle = `Original ${scope} report`;
        const renamedTitle = `Renamed ${scope} report`;
        const replacementTitle = `Replacement ${scope} report`;
        const { patchId } = yield* publish(originalTitle, scope, null, oldName);
        yield* publish(renamedTitle, undefined, patchId, newName);

        for (const suffix of suffixes) {
          const url = `${oldPath}${suffix}`;
          const redirect = yield* get(url);
          assert.strictEqual(redirect.status, 308, url);
          assert.strictEqual(redirect.headers.location, `${newPath}${suffix}`);
          assert.strictEqual(redirect.headers["cache-control"], "private, no-store");

          // Even a public patch's historical version needs company admission.
          const isPublic = scope === "public" && suffix === "";
          const signedOut = yield* get(url, {});
          assert.strictEqual(signedOut.status, isPublic ? 308 : 401, url);
          assert.strictEqual(signedOut.headers["cache-control"], "private, no-store");
          const outsider = yield* get(url, foreign);
          assert.strictEqual(outsider.status, isPublic ? 308 : 404, url);
          if (isPublic) {
            assert.strictEqual(signedOut.headers.location, newPath);
            assert.strictEqual(outsider.headers.location, newPath);
            assert.isUndefined(signedOut.headers["x-patchy-sign-in-url"]);
          } else {
            assert.isUndefined(signedOut.headers.location);
            const door = yield* signedOut.text;
            assert.include(door, ">Sign in</a>");
            assert.notInclude(door, newName);
            assert.notInclude(door, originalTitle);
            assert.notInclude(door, renamedTitle);
            assert.isUndefined(outsider.headers.location);
            assert.isUndefined(outsider.headers["x-patchy-sign-in-url"]);
            const denied = yield* outsider.text;
            assert.notInclude(denied, newName);
            assert.notInclude(denied, originalTitle);
            assert.notInclude(denied, renamedTitle);
          }
        }

        const replacement = yield* publish(replacementTitle, scope, null, oldName);
        for (const suffix of suffixes) {
          const response = yield* get(
            `${oldPath}${suffix}`,
            scope === "public" ? {} : { cookie: signedInCookies() }
          );
          assert.strictEqual(response.status, 200);
          assert.isUndefined(response.headers.location);
          const body = yield* response.text;
          assert.include(body, `&lt;h1&gt;${replacementTitle}&lt;/h1&gt;`);
          assert.notInclude(body, originalTitle);
          assert.notInclude(body, renamedTitle);
        }

        yield* patches.delete(replacement.patchId, { userId: DEV_SEED.userId, admin: false });
        for (const suffix of suffixes) {
          const deleted = yield* get(`${oldPath}${suffix}`);
          assert.strictEqual(deleted.status, 200);
          assert.isUndefined(deleted.headers.location);
          assert.notInclude(yield* deleted.text, originalTitle);
        }
        const original = yield* get(newPath);
        assert.strictEqual(original.status, 200);
        assert.include(yield* original.text, `&lt;h1&gt;${renamedTitle}&lt;/h1&gt;`);
      }
    })
  );

  it.effect("keeps removed /d routes and bare company handles out of address admission", () =>
    Effect.gen(function* () {
      const { patchId } = yield* publish("Removed route must stay hidden");
      const client = yield* HttpClient.HttpClient;
      const paths = [
        `/${DEV_SEED.companyHandle}`,
        ...[patchId, "missing-patch"].flatMap((id) => [`/d/${id}`, `/d/${id}/v/1`, `/d/${id}/~v/1`])
      ];
      for (const url of paths) {
        for (const method of ["GET", "HEAD"] as const) {
          const response = yield* client.execute(
            method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.head(url)
          );
          assert.strictEqual(response.status, 404, `${method} ${url}`);
          assert.strictEqual(response.headers["cache-control"], "no-store");
          assert.isUndefined(response.headers.location);
          assert.isUndefined(response.headers["x-patchy-sign-in-url"]);
          const body = yield* response.text;
          assert.notInclude(body, ">Sign in</a>");
          assert.notInclude(body, "Removed route must stay hidden");
          if (method === "HEAD") assert.strictEqual(body, "");
        }
      }
    })
  );

  it.effect("matches static routes before the patch-address wildcard", () =>
    Effect.gen(function* () {
      for (const url of ["/healthz", "/auth/session.js"]) {
        const response = yield* get(url, {});
        assert.strictEqual(response.status, 200, url);
        assert.strictEqual(response.headers["cache-control"], "no-store");
        assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
        assert.isUndefined(response.headers["x-patchy-sign-in-url"]);
        if (url === "/auth/session.js") {
          assert.include(response.headers["content-type"], "text/javascript");
        } else if (url === "/healthz") {
          assert.deepStrictEqual(yield* response.json, { ok: true });
        }
      }
    })
  );

  it.effect("404s as HTML, uncached, and keeps a patch URL's headers on the 404 too", () =>
    Effect.gen(function* () {
      const { path } = yield* publish("One version");
      for (const url of [
        `/${DEV_SEED.companyHandle}/doesnotexist1`,
        `${path}/~v/9`,
        `${path}/~v/x`
      ]) {
        const response = yield* get(url);
        assert.strictEqual(response.status, 404, url);
        assert.strictEqual(response.headers["x-robots-tag"], "noindex");
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        assert.include(response.headers["content-type"], "text/html");
        assert.notInclude(yield* response.text, "One version");
      }
      const elsewhere = yield* get("/nothing");
      assert.strictEqual(elsewhere.status, 404);
      assert.strictEqual(elsewhere.headers["cache-control"], "no-store");
      assert.include(elsewhere.headers["content-type"], "text/html");
    })
  );

  it.effect(
    "keeps an unvisited patch serving and replaces off content with a restorable notice",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const { path, patchId } = yield* publish("Still available");
        yield* TestClock.adjust(365 * DAY);
        assert.strictEqual((yield* get(path)).status, 200);
        assert.strictEqual((yield* get(`${path}/~v/1`)).status, 200);
        yield* (yield* Patches.Patches).retire(patchId, { userId: DEV_SEED.userId, admin: false });
        const retired = yield* get(path);
        assert.strictEqual(retired.status, 200);
        const notice = yield* retired.text;
        assert.include(notice, 'action="/patches/still-available/restore"');
        assert.include(notice, 'name="expectedState" value="retired"');
        assert.notInclude(notice, 'class="patch-frame"');
        assert.strictEqual((yield* get(`${path}/~v/1`)).status, 200);
        const patches = yield* Patches.Patches;
        const actor = { userId: DEV_SEED.userId, admin: false };
        yield* patches.restore(patchId, actor);
        assert.strictEqual((yield* get(path)).status, 200);
        yield* patches.delete(patchId, actor);
        const deleted = yield* get(path);
        assert.strictEqual(deleted.status, 200);
        assert.include(yield* deleted.text, 'name="expectedState" value="deleted"');
        assert.strictEqual((yield* get(`${path}/~v/1`)).status, 200);
        yield* patches.restore(patchId, actor);
        assert.strictEqual((yield* get(`${path}/~v/1`)).status, 200);
      })
  );

  it.effect("serves the page when recording a visit fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const { path, patchId } = yield* publish("Survives a failed visit");
      const sql = yield* SqlClient.SqlClient;
      yield* ddl(
        `CREATE FUNCTION fail_visit() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'Forced visit recording failure.'; END
          $$ LANGUAGE plpgsql`,
        `CREATE TRIGGER fail_visit BEFORE UPDATE OF visit_count ON patches
            FOR EACH ROW EXECUTE FUNCTION fail_visit()`
      );

      const [before] = yield* sql`SELECT visit_count FROM patches WHERE id = ${patchId}`;
      const served = yield* get(path);
      assert.strictEqual(served.status, 200);
      assert.include(yield* served.text, "Survives a failed visit");
      const [after] = yield* sql`SELECT visit_count FROM patches WHERE id = ${patchId}`;
      assert.deepStrictEqual(after, before);
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
  it.effect("serves UTF-8 content without requiring a meta tag or changing its BOM", () =>
    Effect.gen(function* () {
      const { patchId, versionId } = yield* publish("Unicode content", "public");
      const store = yield* ContentStore.ContentStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patch_versions SET tier = 1 WHERE id = ${versionId}`;
      for (const bom of ["", "\uFEFF"]) {
        const html = `${bom}<!doctype html><html><body><p>café — 日本語</p></body></html>`;
        yield* store.put(Content.objectKey(patchId, versionId), html);
        const response = yield* send(`/~content/${patchId}/${versionId}`);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("content-type"), "text/html; charset=utf-8");
        assert.deepStrictEqual(
          new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
          new TextEncoder().encode(html)
        );
      }
    })
  );

  it.effect("keeps storage faults behind admission without disclosing a private patch", () =>
    Effect.gen(function* () {
      const { patchId, versionId, path } = yield* publish("Missing private bytes");
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
        const response = yield* send(path, { headers });
        assert.strictEqual(response.status, "cookie" in headers ? 404 : 401);
        assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
        const body = yield* Effect.promise(() => response.text());
        assert.notInclude(body, "Missing private bytes");
        if ("cookie" in headers) {
          const missing = yield* send(`/${DEV_SEED.companyHandle}/notthere`, { headers });
          assert.strictEqual(missing.status, 404);
          assert.strictEqual(body, yield* Effect.promise(() => missing.text()));
        } else {
          assert.include(body, ">Sign in</a>");
        }
      }
    })
  );

  it.effect("opens a company patch for an email sign-in with no display name", () =>
    Effect.gen(function* () {
      const { path } = yield* publish("Email-only colleague");
      const response = yield* send(path, {
        headers: { cookie: signedInCookies(signSession({ name: null })) }
      });
      assert.strictEqual(response.status, 200);
      assert.include(
        yield* Effect.promise(() => response.text()),
        "&lt;h1&gt;Email-only colleague&lt;/h1&gt;"
      );
    })
  );

  it.effect("uses the login template without disclosing a retained company patch's content", () =>
    Effect.gen(function* () {
      const { path: patchPath } = yield* publish("Hidden title");
      for (const path of [patchPath, `${patchPath}/~v/1`]) {
        const door = yield* send(path, { headers: { authorization: "Bearer patchy-dev-token" } });
        const login = yield* send(`/login?return=${encodeURIComponent(path)}`);
        assert.strictEqual(door.status, 401);
        assert.strictEqual(door.headers.get("cache-control"), "private, no-store");
        assert.strictEqual(
          door.headers.get("content-security-policy"),
          login.headers.get("content-security-policy")
        );
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
        const patch = yield* publish("Failed handshake");
        const path = `${patch.path}?view=chart`;
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
        const { path } = yield* publish("Do not disclose");
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
        const missing = yield* send(`/${DEV_SEED.companyHandle}/missingpatch`, {
          headers: foreign
        });
        const denied = yield* send(path, { headers: foreign });
        assert.strictEqual(denied.status, 404);
        assert.strictEqual(missing.status, 404);
        assert.deepStrictEqual([...denied.headers], [...missing.headers]);
        assert.strictEqual(
          yield* Effect.promise(() => denied.text()),
          yield* Effect.promise(() => missing.text())
        );
        const unenrolled = yield* send(path, {
          headers: {
            cookie: signedInCookies(signSession({ sub: "user_new", email: "new@example.com" }))
          }
        });
        assert.strictEqual(unenrolled.status, 303);
        assert.strictEqual(
          unenrolled.headers.get("location"),
          `/join?return=${encodeURIComponent(path)}`
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
        const deactivated = yield* send(path, {
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
        const { patchId, path: patchPath } = yield* publish("Sharing boundary");
        const patches = yield* Patches.Patches;
        for (const scope of ["company", "public", "company"] as const) {
          yield* patches.setScope(patchId, { userId: DEV_SEED.userId, admin: false }, scope);
          for (const path of [patchPath, `${patchPath}/~v/1`]) {
            const response = yield* send(path, { headers: { cookie: signedInCookies() } });
            assert.strictEqual(response.status, 200);
            const body = yield* Effect.promise(() => response.text());
            assert.include(body, 'sandbox=""');
            assert.include(body, "&lt;h1&gt;Sharing boundary&lt;/h1&gt;");
            if (scope === "public") {
              assert.strictEqual(response.headers.get("cache-control"), "public, max-age=60");
              assert.strictEqual(
                response.headers.get("content-security-policy"),
                `${CSP}; frame-ancestors 'none'`
              );
              assert.notInclude(body, "<script");
              assert.deepStrictEqual(response.headers.getSetCookie(), []);
            } else {
              assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
              assert.strictEqual(
                response.headers.get("content-security-policy"),
                `${CSP}; frame-ancestors 'none'; script-src 'self' https://${FRONTEND_API_HOST}; connect-src https://${FRONTEND_API_HOST}`
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
