import { createHash, randomUUID } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { CURRENT_RELEASE, MANIFEST_VERSION, WIRE_VERSION, type Manifest } from "@patchy/api";
import { AgentConnections, AuthPages, DeviceLogins, MachineTokens, Session } from "@patchy/auth";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
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
import { contentHash } from "../../../test/crypto.js";
import { Content, GuestGrants, Patches } from "@patchy/patches";
import { ConnectionStoreDev } from "@patchy/integrations/dev";
import { ddl, layerFromUrl } from "@patchy/sql";
import * as Testing from "@patchy/company-database/testing";
import { Tables } from "@patchy/primitives";
import * as Wakes from "../../runtime/src/Wakes.js";
import * as Pages from "./Pages.js";
import {
  CONTENT_SECURITY_POLICY,
  SHELL_SECURITY_POLICY,
  servingHeaders,
  shellContentSecurityPolicy
} from "./serving-headers.js";
import { brokerScript, brokerSrc } from "./shell.js";
import { compress } from "./compression.js";

const DAY = 24 * 60 * 60 * 1000;

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

const tracked: Analytics.AnalyticsEvent[] = [];
const recordingAnalytics = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void tracked.push(event)) })
);
/** The first opens reported about one patch, in order. */
const firstOpens = (patchId: string) =>
  tracked.filter(
    (event) => event.name === "patch.first_opened" && event.properties.patchId === patchId
  );

const routes = Layer.mergeAll(
  Pages.layer,
  AuthPages.layer,
  HttpRouter.add("*", "/*", Pages.notFound),
  HttpRouter.middleware(servingHeaders, { global: true })
);
const services = Layer.mergeAll(Content.layer, DeviceLogins.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      GuestGrants.layer.pipe(Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer))),
      memoryStore,
      Session.layer,
      Companies.layer,
      MachineTokens.layer,
      AgentConnections.layer,
      Limits.layer,
      InviteMail.layerRecording
    )
  ),
  Layer.provideMerge(recordingAnalytics),
  Layer.provideMerge(ConnectionStoreDev.layer([])),
  Layer.provideMerge(Tables.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge([Testing.resourceChangesLayer, Wakes.layer]),
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
          tier: 1,
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
        yield* publish("Latest hidden content", undefined, patch.patchId);
        yield* patches.reassign(patch.patchId, { userId: DEV_SEED.userId, admin: true }, ownerId);
        const actor = { userId: ownerId, admin: false };
        // The address, a historical version and a content URL share one notice.
        const paths = [
          patch.path,
          `${patch.path}/~v/1`,
          `/~content/${patch.patchId}/${patch.versionId}`
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
              if (person.manage) {
                assert.include(html, `name="expectedPatchId" value="${patch.patchId}"`);
                assert.include(html, `name="expectedState" value="${state}"`);
              }
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
            content ? CONTENT_SECURITY_POLICY : SHELL_SECURITY_POLICY
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
            assert.notInclude(body, "<script");
          } else {
            assert.include(body, 'class="patch-frame"');
            assert.include(body, `data-version-id="${current.versionId}"`);
            // The broker is the public shell's only script.
            assert.deepStrictEqual(
              [...body.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag),
              [`<script defer src="${brokerSrc}">`]
            );
          }
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
          if (url.startsWith("/~content/")) {
            assert.strictEqual(
              colleague.headers["content-security-policy"],
              "sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-ancestors 'self'"
            );
            assert.strictEqual(
              history,
              "<!doctype html><html><head><title>Company-only history</title></head><body><h1>Company-only history</h1></body></html>"
            );
          } else assert.include(history, `data-version-id="${olderVersionId}"`);
        }
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
          assert.include(body, `<title>${replacementTitle}</title>`);
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
        assert.include(yield* original.text, `<title>${renamedTitle}</title>`);
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

  it.effect("answers the deep health check from the database, naming the running build", () =>
    Effect.gen(function* () {
      const response = yield* get("/healthz/deep", {});
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["cache-control"], "no-store");
      assert.deepStrictEqual(yield* response.json, { ok: true, revision: "development" });
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
      // A bare company handle is not an address: it gets the plain 404, not a sign-in door.
      for (const url of ["/nothing", `/${DEV_SEED.companyHandle}`]) {
        const elsewhere = yield* get(url, {});
        assert.strictEqual(elsewhere.status, 404, url);
        assert.strictEqual(elsewhere.headers["cache-control"], "no-store");
        assert.isUndefined(elsewhere.headers["x-patchy-sign-in-url"]);
        assert.include(elsewhere.headers["content-type"], "text/html");
      }
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

  it.effect("records a member's open of the address, never the content URL or a public page", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const company = yield* publish("Opened by a member");
      const open = yield* publish("Opened by anyone", "public");
      const scores = Effect.map(
        patches.opens(DEV_SEED.userId),
        (opens) => new Map(opens.map((entry) => [entry.patchId, entry.score]))
      );
      assert.strictEqual((yield* get(company.path)).status, 200);
      yield* get(`/~content/${company.patchId}/${company.versionId}`);
      yield* get(company.path, {});
      assert.strictEqual((yield* get(open.path)).status, 200);
      const recorded = yield* scores;
      assert.closeTo(recorded.get(company.patchId)!, 1, 1e-9);
      assert.isFalse(recorded.has(open.patchId));
      // A colleague reading v1 after v2 is out hasn't seen what changed.
      yield* publish("Opened by a member, again", undefined, company.patchId);
      assert.strictEqual((yield* get(`${company.path}/~v/1`)).status, 200);
      assert.closeTo((yield* scores).get(company.patchId)!, 1, 1e-9);
    })
  );

  it.effect("reports a colleague's first open of a patch, and no other open", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const colleagueId = "usr_first_open_colleague";
      const email = `${colleagueId}@example.com`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${colleagueId}, ${colleagueId}, ${DEV_SEED.companyId}, ${email}, 'Sam', 'member')`;
      const colleague = {
        cookie: signedInCookies(signSession({ sub: colleagueId, email, name: "Sam" }))
      };
      const patch = yield* publish("First opened by a colleague");
      const welcome = yield* publish("Your welcome page", undefined, null, "welcome");
      const shared = yield* publish("Public at its first open", "public");

      // The owner's own first open, a public patch and an older version report nothing.
      assert.strictEqual((yield* get(patch.path)).status, 200);
      assert.strictEqual((yield* get(shared.path, colleague)).status, 200);
      yield* publish("First opened by a colleague, again", undefined, patch.patchId);
      assert.strictEqual((yield* get(`${patch.path}/~v/1`, colleague)).status, 200);
      assert.deepStrictEqual(firstOpens(patch.patchId), []);
      assert.deepStrictEqual(firstOpens(shared.patchId), []);

      // The colleague's first open of the current version reports once; opening it again doesn't.
      assert.strictEqual((yield* get(patch.path, colleague)).status, 200);
      assert.strictEqual((yield* get(patch.path, colleague)).status, 200);
      assert.deepStrictEqual(firstOpens(patch.patchId), [
        {
          name: "patch.first_opened",
          principalId: colleagueId,
          companyId: DEV_SEED.companyId,
          properties: {
            patchId: patch.patchId,
            ownerUserId: DEV_SEED.userId,
            tier: 1,
            welcomePage: false
          }
        }
      ]);
      assert.strictEqual((yield* get(welcome.path, colleague)).status, 200);
      assert.deepStrictEqual(
        firstOpens(welcome.patchId).map((event) => event.properties),
        [{ patchId: welcome.patchId, ownerUserId: DEV_SEED.userId, tier: 1, welcomePage: true }]
      );
    })
  );

  it.effect("serves the page when recording an open fails", () =>
    Effect.gen(function* () {
      const { path, patchId } = yield* publish("Survives a failed open");
      yield* ddl(
        `CREATE FUNCTION fail_open() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'Forced open recording failure.'; END
          $$ LANGUAGE plpgsql`,
        `CREATE TRIGGER fail_open BEFORE INSERT OR UPDATE ON patch_opens
            FOR EACH ROW EXECUTE FUNCTION fail_open()`
      );
      const served = yield* get(path);
      assert.strictEqual(served.status, 200);
      assert.include(yield* served.text, "Survives a failed open");
      const opened = yield* (yield* Patches.Patches).opens(DEV_SEED.userId);
      assert.notInclude(
        opened.map((entry) => entry.patchId),
        patchId
      );
      yield* ddl(`DROP TRIGGER fail_open ON patch_opens`, `DROP FUNCTION fail_open()`);
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

  it.effect("answers HEAD on content with the compressed body's headers", () =>
    Effect.gen(function* () {
      const { patchId, versionId } = yield* publish("Head content");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patch_versions SET tier = 1 WHERE id = ${versionId}`;
      const url = `/~content/${patchId}/${versionId}`;
      const headers = { cookie: signedInCookies(), "accept-encoding": "br" };
      const full = yield* get(url, headers);
      assert.strictEqual(full.headers["content-encoding"], "br");
      const client = yield* HttpClient.HttpClient;
      const head = yield* client.execute(
        HttpClientRequest.head(url).pipe(HttpClientRequest.setHeaders(headers))
      );
      assert.strictEqual(head.status, 200);
      assert.strictEqual(head.headers["content-encoding"], "br");
      assert.strictEqual(head.headers["vary"], "Accept-Encoding");
      // The length of the brotli body a GET sends, which no HEAD body follows.
      assert.strictEqual(head.headers["content-length"], full.headers["content-length"]);
      const stored = yield* (yield* ContentStore.ContentStore).get(
        Content.objectKey(patchId, versionId)
      );
      assert.isBelow(Number(head.headers["content-length"]), Buffer.byteLength(stored));
      assert.strictEqual((yield* head.arrayBuffer).byteLength, 0);
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

/** The health routes alone, over a database that refuses every connection. */
const unreachableDatabase = HttpRouter.serve(Pages.health, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(layerFromUrl(Redacted.make("postgresql://postgres:postgres@127.0.0.1:1/patchy"))),
  Layer.provide(
    ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_DEPLOYMENT_REVISION: "abc123" }))
  )
);

it.layer(unreachableDatabase)("health without a database", (it) => {
  it.effect("keeps the shallow check up and fails the deep one, still naming the build", () =>
    Effect.gen(function* () {
      const shallow = yield* get("/healthz", {});
      assert.strictEqual(shallow.status, 200);
      const deep = yield* get("/healthz/deep", {});
      assert.strictEqual(deep.status, 503);
      assert.deepStrictEqual(yield* deep.json, { ok: false, revision: "abc123" });
    })
  );
});

it.layer(services)("pages in memory", (it) => {
  const IMMUTABLE = "public, max-age=31536000, immutable";
  const script = new TextEncoder().encode(brokerScript);
  const decoded = Effect.fn(function* (response: Response) {
    const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
    const coding = response.headers.get("content-encoding");
    return coding === "br"
      ? brotliDecompressSync(body)
      : coding === "gzip"
        ? gunzipSync(body)
        : body;
  });

  it.effect("names the broker's bytes in a scripted shell's URL", () =>
    Effect.gen(function* () {
      const { path, versionId } = yield* publish("Scripted shell", "public");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patch_versions SET tier = 1 WHERE id = ${versionId}`;
      const shell = yield* send(path);
      const src =
        (yield* Effect.promise(() => shell.text())).match(/<script defer src="([^"]+)">/)?.[1] ??
        "";
      assert.strictEqual(src, brokerSrc);
      const broker = yield* send(src);
      assert.strictEqual(broker.headers.get("cache-control"), IMMUTABLE);
      assert.strictEqual(
        createHash("sha256")
          .update(yield* decoded(broker))
          .digest("hex"),
        new URL(src, PUBLIC_BASE_URL).searchParams.get("v")
      );
    })
  );

  it.effect("compresses the broker by Accept-Encoding, immutable under its own digest", () =>
    Effect.gen(function* () {
      for (const [accept, coding] of [
        ["gzip, deflate, br, zstd", "br"],
        ["gzip", "gzip"],
        ["br;q=0.5, gzip", "gzip"],
        ["identity", "identity"],
        ["br;q=0, gzip;q=0", "identity"],
        [undefined, "identity"]
      ] as const) {
        const response = yield* send(
          brokerSrc,
          accept === undefined ? {} : { headers: { "accept-encoding": accept } }
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("cache-control"), IMMUTABLE);
        assert.strictEqual(response.headers.get("vary"), "Accept-Encoding");
        assert.strictEqual(
          response.headers.get("content-encoding"),
          coding === "identity" ? null : coding,
          accept
        );
        assert.isTrue(Buffer.from(yield* decoded(response)).equals(script), accept);
      }
    })
  );

  it.effect("revalidates the broker under a foreign or missing digest", () =>
    Effect.gen(function* () {
      for (const url of ["/~shell/broker.js", `/~shell/broker.js?v=${"0".repeat(64)}`]) {
        const response = yield* send(url, { headers: { "accept-encoding": "br" } });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("cache-control"), "no-cache", url);
        assert.isTrue(Buffer.from(yield* decoded(response)).equals(script), url);
      }
    })
  );

  it.effect("loads a new shell's broker from a host still on the previous release", () =>
    Effect.gen(function* () {
      // The previous release's route, on the same router: it never read the query.
      const previous = yield* HttpRouter.toHttpEffect(
        HttpRouter.add(
          "GET",
          "/~shell/broker.js",
          HttpServerResponse.text("previous broker", {
            contentType: "text/javascript",
            headers: { "cache-control": "no-store" }
          })
        )
      );
      const response = HttpServerResponse.toWeb(
        yield* previous.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(new URL(brokerSrc, PUBLIC_BASE_URL)))
          )
        )
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      assert.strictEqual(yield* Effect.promise(() => response.text()), "previous broker");
    })
  );

  it.effect("serves UTF-8 content without requiring a meta tag or changing its BOM", () =>
    Effect.gen(function* () {
      const { patchId, versionId } = yield* publish("Unicode content", "public");
      const store = yield* ContentStore.ContentStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patch_versions SET tier = 1 WHERE id = ${versionId}`;
      for (const bom of ["", "\uFEFF"]) {
        const html = `${bom}<!doctype html><html><body><p>café — 日本語</p></body></html>`;
        yield* store.put(Content.objectKey(patchId, versionId), html);
        // Stored bytes never change once published; these are recorded as new ones.
        yield* sql`UPDATE patch_versions SET content_hash = ${contentHash(html)},
          file_size = ${Buffer.byteLength(html)} WHERE id = ${versionId}`;
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
      const viewers: ReadonlyArray<Record<string, string>> = [
        {},
        {
          cookie: signedInCookies(
            signSession({ sub: "user_storage_outsider", email: "storage@example.com" })
          )
        }
      ];
      for (const headers of viewers) {
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
        "<title>Email-only colleague</title>"
      );
    })
  );

  it.effect("never records a first open it doesn't report when the reader leaves mid-open", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const colleagueId = "usr_leaving_colleague";
      const email = `${colleagueId}@example.com`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${colleagueId}, ${colleagueId}, ${DEV_SEED.companyId}, ${email}, 'Ana', 'member')`;
      const { path, patchId } = yield* publish("Opened as its reader leaves");
      // Recording the open takes a second, and the reader leaves during it. The open stays
      // cancellable, so it either commits and reports or leaves nothing behind.
      yield* ddl(
        `CREATE FUNCTION slow_open() RETURNS trigger AS $$
            BEGIN PERFORM pg_sleep(1); RETURN NULL; END
          $$ LANGUAGE plpgsql`,
        `CREATE TRIGGER slow_open AFTER INSERT ON patch_opens
            FOR EACH ROW EXECUTE FUNCTION slow_open()`
      );
      const opening = yield* send(path, {
        headers: { cookie: signedInCookies(signSession({ sub: colleagueId, email })) }
      }).pipe(Effect.forkChild);
      yield* sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'PgSleep'`.pipe(
        Effect.repeat({ until: (rows) => rows.length === 1 })
      );
      yield* Fiber.interrupt(opening);
      yield* ddl(`DROP TRIGGER slow_open ON patch_opens`, `DROP FUNCTION slow_open()`);
      const recorded = yield* sql`SELECT 1 FROM patch_opens
        WHERE user_id = ${colleagueId} AND patch_id = ${patchId}`;
      assert.strictEqual(firstOpens(patchId).length, recorded.length);
      assert.strictEqual(recorded.length, 0);
    })
  );

  it.effect("uses the login template without disclosing a retained company patch's content", () =>
    Effect.gen(function* () {
      const { path: patchPath, patchId, versionId } = yield* publish("Hidden title");
      for (const path of [patchPath, `${patchPath}/~v/1`, `/~content/${patchId}/${versionId}`]) {
        const door = yield* send(path, { headers: { authorization: "Bearer patchy-dev-token" } });
        const login = yield* send(`/login?return=${encodeURIComponent(path)}`);
        assert.strictEqual(door.status, 401);
        assert.strictEqual(door.headers.get("cache-control"), "private, no-store");
        // Content URLs keep their sandbox policy even on the door.
        if (!path.startsWith("/~content/")) {
          assert.strictEqual(
            door.headers.get("content-security-policy"),
            login.headers.get("content-security-policy")
          );
        }
        assert.isNull(door.headers.get("location"));
        assert.isNull(door.headers.get("www-authenticate"));
        const body = yield* Effect.promise(() => door.text());
        assert.strictEqual(body, yield* Effect.promise(() => login.text()));
        assert.notInclude(body, "Hidden title");
        assert.strictEqual(
          (body.match(/<a /g) ?? []).length,
          2,
          "only Sign in and Join the waitlist"
        );
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
            assert.include(body, 'sandbox="allow-scripts allow-modals"');
            assert.include(body, "<title>Sharing boundary</title>");
            if (scope === "public") {
              assert.strictEqual(response.headers.get("cache-control"), "public, max-age=60");
              assert.strictEqual(
                response.headers.get("content-security-policy"),
                SHELL_SECURITY_POLICY
              );
              assert.strictEqual((body.match(/<script\b/g) ?? []).length, 1);
              assert.deepStrictEqual(response.headers.getSetCookie(), []);
            } else {
              assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
              assert.strictEqual(
                response.headers.get("content-security-policy"),
                shellContentSecurityPolicy(FRONTEND_API_HOST)
              );
              assert.include(
                body,
                `src="https://${FRONTEND_API_HOST}/npm/@clerk/clerk-js@5/dist/clerk.headless.browser.js"`
              );
              assert.include(body, 'src="/auth/session.js"');
              assert.strictEqual((body.match(/<script\b/g) ?? []).length, 3);
              assert.notMatch(body, /<script\b[^>]*>[^<]+<\/script>/);
              assert.strictEqual((yield* send(path)).status, 401);
            }
          }
        }
      })
  );

  /** A published tier 1 version's content URL, with its stored document. */
  const scripted = Effect.fn(function* (title: string) {
    const { patchId, versionId, path } = yield* publish(title);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE patch_versions SET tier = 1 WHERE id = ${versionId}`;
    const html = yield* (yield* ContentStore.ContentStore).get(
      Content.objectKey(patchId, versionId)
    );
    return { patchId, versionId, path, html, url: `/~content/${patchId}/${versionId}?n=boot_x` };
  });

  /**
   * One host's routes, built once so requests share its content documents, over the memory
   * store with document reads counted. `beforeRead` runs inside each read, and `afterFind` after
   * each retained-version lookup: a content request's last wait before the documents. Requests
   * run inside request events whose `contentLoad` and `contentEncoding` `loads` takes in order.
   */
  const host = Effect.fn(function* (
    options: {
      readonly limits?: Partial<
        Record<"serving.contentCache.bytes" | "serving.contentCache.entries", number>
      >;
      readonly compression?: typeof compress;
    } = {}
  ) {
    const memory = yield* ContentStore.ContentStore;
    const control = {
      reads: 0,
      beforeRead: Effect.void as Effect.Effect<void>,
      afterFind: Effect.void as Effect.Effect<void>
    };
    const store = ContentStore.ContentStore.of({
      ...memory,
      get: (key) =>
        Effect.suspend(() => {
          control.reads++;
          return control.beforeRead.pipe(Effect.andThen(memory.get(key)));
        })
    });
    const patches = Layer.effect(
      Patches.Patches,
      Effect.map(Patches.make, (patches) =>
        Patches.Patches.of({
          ...patches,
          findRetained: (...args) =>
            patches.findRetained(...args).pipe(Effect.tap(() => control.afterFind))
        })
      )
    );
    // Fresh, so the suite's memoized `Content` over the plain store isn't reused.
    const context = yield* Layer.build(
      Layer.fresh(Content.layer).pipe(
        Layer.provideMerge(patches),
        Layer.provide(Layer.succeed(ContentStore.ContentStore, store))
      )
    );
    const app = yield* HttpRouter.toHttpEffect(routes).pipe(
      Effect.provide(context),
      Effect.provideService(Pages.DocumentCompression, options.compression ?? compress),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...clerkEnv(),
            PATCHY_LIMITS_JSON: JSON.stringify(options.limits ?? {})
          })
        )
      )
    );
    const records = yield* Queue.unbounded<WideEvents.WideEvent>();
    const events = yield* WideEvents.make.pipe(
      Effect.provideService(WideEvents.Sink, {
        write: (event) => Queue.offer(records, event).pipe(Effect.asVoid)
      })
    );
    const request = (
      path: string,
      headers: Record<string, string> = { cookie: signedInCookies() }
    ) =>
      events
        .withEvent(
          { type: "request" },
          app.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request(new URL(path, PUBLIC_BASE_URL), { headers }))
            ),
            // A route's request services come from the request, as the server provides them.
            Effect.provide(context)
          )
        )
        .pipe(Effect.map(HttpServerResponse.toWeb));
    const loads = Effect.map(Queue.take(records), (event) =>
      event.type === "request"
        ? { load: event.contentLoad, encoding: event.contentEncoding }
        : undefined
    );
    return { control, request, loads };
  });

  it.effect("reads a content document from storage once, then sends it from memory", () =>
    Effect.gen(function* () {
      const { url, html } = yield* scripted("Kept once");
      const { control, request, loads } = yield* host();
      for (const accept of ["br", "gzip", undefined]) {
        const response = yield* request(url, {
          cookie: signedInCookies(),
          ...(accept === undefined ? {} : { "accept-encoding": accept })
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(new TextDecoder().decode(yield* decoded(response)), html);
      }
      assert.strictEqual(control.reads, 1);
      assert.deepStrictEqual(
        [yield* loads, yield* loads, yield* loads],
        [
          { load: "read", encoding: "br" },
          { load: "cached", encoding: "gzip" },
          { load: "cached", encoding: "identity" }
        ]
      );
    })
  );

  /** A request whose route died, which the server answers with a 500. */
  const fault = <A, E, R>(request: Effect.Effect<A, E, R>) =>
    Effect.map(Effect.exit(request), (exit) =>
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
    );

  it.effect("shares one read between simultaneous content loads and keeps no failure", () =>
    Effect.gen(function* () {
      const { url, html } = yield* scripted("Joined once");
      const { control, request, loads } = yield* host();
      let found = 0;
      const bothFound = yield* Deferred.make<void>();
      control.afterFind = Effect.suspend(() =>
        ++found === 2 ? Deferred.succeed(bothFound, undefined) : Effect.void
      );
      const opened = yield* Deferred.make<void>();
      control.beforeRead = Deferred.await(opened);
      // Neither request yields on its op budget: past its lookup, the second runs straight on
      // to wait on the first one's read before this fiber's next turn.
      const both = yield* Effect.all([request(url), request(url)], {
        concurrency: "unbounded"
      }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true), Effect.forkScoped);
      yield* Deferred.await(bothFound);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(opened, undefined);
      for (const response of yield* Fiber.join(both)) {
        assert.strictEqual(response.status, 200);
        assert.strictEqual(yield* Effect.promise(() => response.text()), html);
      }
      assert.strictEqual(control.reads, 1);
      assert.sameMembers([(yield* loads)?.load, (yield* loads)?.load], ["read", "joined"]);

      // A failed read is a fault for this request (the server's 500), and the next one reads again.
      control.afterFind = Effect.void;
      control.beforeRead = Effect.void;
      const missing = yield* scripted("Read again");
      const store = yield* ContentStore.ContentStore;
      const key = Content.objectKey(missing.patchId, missing.versionId);
      yield* store.delete(key);
      yield* fault(request(missing.url));
      yield* store.put(key, missing.html);
      const recovered = yield* request(missing.url);
      assert.strictEqual(recovered.status, 200);
      assert.strictEqual(yield* Effect.promise(() => recovered.text()), missing.html);
      assert.strictEqual(control.reads, 3);

      // Bytes that no longer match the recorded digest are a fault too, and never kept.
      const tampered = yield* scripted("Tampered");
      yield* store.put(Content.objectKey(tampered.patchId, tampered.versionId), "<p>tampered</p>");
      yield* fault(request(tampered.url));
      yield* fault(request(tampered.url));
      assert.strictEqual(control.reads, 5);
    })
  );

  it.effect("admits every content request, so a kept document is refused once access ends", () =>
    Effect.gen(function* () {
      const { url, html, patchId } = yield* scripted("Kept behind the door");
      const { control, request } = yield* host();
      const sql = yield* SqlClient.SqlClient;
      const memberId = "usr_content_member";
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${memberId}, ${memberId}, ${DEV_SEED.companyId}, 'member@example.com', 'Member', 'member')`;
      const member = {
        cookie: signedInCookies(signSession({ sub: memberId, email: "member@example.com" })),
        "accept-encoding": "br"
      };
      const opened = yield* request(url, member);
      assert.strictEqual(opened.status, 200);
      assert.strictEqual(new TextDecoder().decode(yield* decoded(opened)), html);
      yield* (yield* Companies.Companies).create({
        name: "Content outsider",
        handle: "content-outsider",
        clerkUserId: "user_content_outsider",
        email: "content-outsider@example.com",
        userName: "Outsider"
      });
      const refusals = {
        "signed out": [{ "accept-encoding": "br" }, 401],
        "another company": [
          {
            cookie: signedInCookies(
              signSession({ sub: "user_content_outsider", email: "content-outsider@example.com" })
            ),
            "accept-encoding": "br"
          },
          404
        ]
      } as const;
      const refused = Effect.fn(function* (
        reason: string,
        headers: Record<string, string>,
        status: number
      ) {
        const response = yield* request(url, headers);
        assert.strictEqual(response.status, status, reason);
        // A refusal is never compressed or varied, and never the document.
        assert.isNull(response.headers.get("content-encoding"), reason);
        assert.isNull(response.headers.get("vary"), reason);
        assert.notInclude(yield* Effect.promise(() => response.text()), "Kept behind the door");
      });
      for (const [reason, [headers, status]] of Object.entries(refusals))
        yield* refused(reason, headers, status);
      yield* (yield* Users.Users).deactivate({ companyId: DEV_SEED.companyId, userId: memberId });
      yield* refused("deactivated", member, 403);
      // An operator-disabled patch is absent even to an active colleague.
      yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${patchId}`;
      yield* refused("disabled", { cookie: signedInCookies(), "accept-encoding": "br" }, 404);
      assert.strictEqual(control.reads, 1);
    })
  );

  it.effect("compresses content by Accept-Encoding with the stored bytes underneath", () =>
    Effect.gen(function* () {
      const { url, html } = yield* scripted("Compressed content");
      const { request } = yield* host();
      for (const [accept, coding] of [
        ["gzip, deflate, br, zstd", "br"],
        ["gzip", "gzip"],
        ["br;q=0.5, gzip", "gzip"],
        ["identity", "identity"],
        [undefined, "identity"]
      ] as const) {
        const response = yield* request(url, {
          cookie: signedInCookies(),
          ...(accept === undefined ? {} : { "accept-encoding": accept })
        });
        assert.strictEqual(response.status, 200, accept);
        assert.strictEqual(response.headers.get("vary"), "Accept-Encoding", accept);
        assert.strictEqual(
          response.headers.get("content-encoding"),
          coding === "identity" ? null : coding,
          accept
        );
        assert.strictEqual(response.headers.get("content-type"), "text/html; charset=utf-8");
        assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
        assert.isTrue(Buffer.from(yield* decoded(response)).equals(Buffer.from(html)), accept);
      }
    })
  );

  it.effect(
    "sends a document too large to keep as stored, and evicts the least recently used",
    () =>
      Effect.gen(function* () {
        const large = yield* scripted("Too large to keep");
        // A quarter of the byte bound is one byte short of this document.
        const tight = yield* host({
          limits: { "serving.contentCache.bytes": (Buffer.byteLength(large.html) - 1) * 4 }
        });
        for (let load = 0; load < 2; load++) {
          const response = yield* tight.request(large.url, {
            cookie: signedInCookies(),
            "accept-encoding": "br"
          });
          assert.strictEqual(response.status, 200);
          assert.isNull(response.headers.get("content-encoding"));
          assert.strictEqual(yield* Effect.promise(() => response.text()), large.html);
        }
        assert.strictEqual(tight.control.reads, 2);

        const { control, request } = yield* host({ limits: { "serving.contentCache.entries": 2 } });
        const [one, two, three] = [
          yield* scripted("One"),
          yield* scripted("Two"),
          yield* scripted("Three")
        ];
        for (const document of [one, two, one]) yield* request(document.url);
        assert.strictEqual(control.reads, 2);
        // A third document evicts `two`, now the least recently used.
        for (const document of [three, one, three]) yield* request(document.url);
        assert.strictEqual(control.reads, 3);
        yield* request(two.url);
        assert.strictEqual(control.reads, 4);
      })
  );

  /**
   * The real compressor, counting its calls and the most running at once. Each call reports
   * `entered`, then waits for `opened`.
   */
  const watchedCompression = Effect.fn(function* () {
    const entered = yield* Queue.unbounded<void>();
    const opened = yield* Deferred.make<void>();
    const watch = { calls: 0, running: 0, most: 0 };
    const compression = (body: Uint8Array) =>
      Effect.suspend(() => {
        watch.calls++;
        watch.most = Math.max(watch.most, ++watch.running);
        return Queue.offer(entered, undefined).pipe(
          Effect.andThen(Deferred.await(opened)),
          Effect.andThen(compress(body)),
          Effect.ensuring(Effect.sync(() => watch.running--))
        );
      });
    return { watch, compression, entered, opened };
  });

  it.effect("compresses one document at a time across the host", () =>
    Effect.gen(function* () {
      const { watch, compression, entered, opened } = yield* watchedCompression();
      const { control, request } = yield* host({ compression });
      const documents = [yield* scripted("Cold one"), yield* scripted("Cold two")];
      documents.push(yield* scripted("Cold three"));
      // The three reads finish together, so all three documents are ready to compress at once.
      const allReading = yield* Deferred.make<void>();
      const readsOpened = yield* Deferred.make<void>();
      control.beforeRead = Effect.suspend(() =>
        control.reads === 3 ? Deferred.succeed(allReading, undefined) : Effect.void
      ).pipe(Effect.andThen(Deferred.await(readsOpened)));
      const all = yield* Effect.all(
        documents.map((document) =>
          request(document.url, { cookie: signedInCookies(), "accept-encoding": "br" })
        ),
        { concurrency: "unbounded" }
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(allReading);
      yield* Deferred.succeed(readsOpened, undefined);
      yield* Queue.take(entered);
      // The other two run only up to the permit; given turns, they still don't compress.
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      assert.strictEqual(watch.calls, 1);
      yield* Deferred.succeed(opened, undefined);
      const responses = yield* Fiber.join(all);
      for (const [index, response] of responses.entries()) {
        assert.strictEqual(response.headers.get("content-encoding"), "br");
        assert.strictEqual(
          new TextDecoder().decode(yield* decoded(response)),
          documents[index]!.html
        );
      }
      assert.deepStrictEqual(watch, { calls: 3, running: 0, most: 1 });
    })
  );

  it.effect("finishes an abandoned load's work, so an immediate retry joins it", () =>
    Effect.gen(function* () {
      const { url, html } = yield* scripted("Abandoned");
      const { watch, compression, entered, opened } = yield* watchedCompression();
      const { control, request, loads } = yield* host({ compression });
      const abandoned = yield* request(url).pipe(Effect.forkScoped);
      yield* Queue.take(entered);
      yield* Fiber.interrupt(abandoned);
      // The retry waits on the abandoned load's work before it is allowed to finish.
      const found = yield* Deferred.make<void>();
      control.afterFind = Deferred.succeed(found, undefined).pipe(Effect.asVoid);
      const retry = yield* request(url).pipe(
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
        Effect.forkScoped
      );
      yield* Deferred.await(found);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(opened, undefined);
      const retried = yield* Fiber.join(retry);
      assert.strictEqual(yield* Effect.promise(() => retried.text()), html);
      yield* request(url);
      assert.strictEqual(control.reads, 1);
      assert.strictEqual(watch.calls, 1);
      assert.deepStrictEqual(
        [(yield* loads)?.load, (yield* loads)?.load, (yield* loads)?.load],
        ["read", "joined", "cached"]
      );
    })
  );

  it.effect("prepares four cold documents at a time, even when their loads are abandoned", () =>
    Effect.gen(function* () {
      const { watch, compression, opened } = yield* watchedCompression();
      yield* Deferred.succeed(opened, undefined);
      const { control, request } = yield* host({ compression });
      const documents: Array<{ readonly url: string; readonly html: string }> = [];
      for (const title of ["One", "Two", "Three", "Four", "Five", "Six"])
        documents.push(yield* scripted(`Burst ${title}`));
      const fourReading = yield* Deferred.make<void>();
      const readsOpened = yield* Deferred.make<void>();
      control.beforeRead = Effect.suspend(() =>
        control.reads === 4 ? Deferred.succeed(fourReading, undefined) : Effect.void
      ).pipe(Effect.andThen(Deferred.await(readsOpened)));
      const loads: Array<Fiber.Fiber<Response, unknown>> = [];
      for (const document of documents)
        loads.push(yield* request(document.url).pipe(Effect.forkScoped));
      yield* Deferred.await(fourReading);
      // The other two wait their turn without reading; given turns, they still don't read.
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      assert.strictEqual(control.reads, 4);
      // Every request goes away; the work it started still finishes and keeps each document.
      for (const load of loads) yield* Fiber.interrupt(load);
      yield* Deferred.succeed(readsOpened, undefined);
      for (const document of documents) {
        const response = yield* request(document.url);
        assert.strictEqual(yield* Effect.promise(() => response.text()), document.html);
      }
      assert.strictEqual(control.reads, 6);
      assert.strictEqual(watch.calls, 6);
      assert.strictEqual(watch.most, 1);
    })
  );

  it.effect("charges a kept document's raw, brotli and gzip bytes against the bound", () =>
    Effect.gen(function* () {
      const documents = [yield* scripted("Budget one"), yield* scripted("Budget two")];
      // Each document's body in every coding, measured on a host of its own.
      const probe = yield* host();
      const held: Array<number> = [];
      const raw: Array<number> = [];
      for (const document of documents) {
        const sizes: Array<number> = [];
        for (const accept of ["identity", "br", "gzip"]) {
          const response = yield* probe.request(document.url, {
            cookie: signedInCookies(),
            "accept-encoding": accept
          });
          sizes.push((yield* Effect.promise(() => response.arrayBuffer())).byteLength);
        }
        raw.push(sizes[0]!);
        held.push(sizes.reduce((sum, size) => sum + size, 0));
      }
      // Each fits alone and both fit by raw bytes, but not by everything they hold.
      const bound = 4 * Math.max(...raw);
      assert.isAtMost(Math.max(...held), bound);
      assert.isAtMost(raw[0]! + raw[1]!, bound);
      assert.isAbove(held[0]! + held[1]!, bound);
      const { control, request } = yield* host({
        limits: { "serving.contentCache.bytes": bound }
      });
      const [one, two] = documents;
      for (const document of [one!, two!, two!]) yield* request(document.url);
      assert.strictEqual(control.reads, 2);
      // Keeping `two` evicted `one`, the least recently used.
      yield* request(one!.url);
      assert.strictEqual(control.reads, 3);
    })
  );
});
