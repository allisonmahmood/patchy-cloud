import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PostgresDeclaration } from "@patchy/api";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConnectionPages from "./ConnectionPages.js";
import * as ConnectionStore from "./ConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as Source from "./postgres/Source.js";
import * as SourceClient from "./postgres/SourceClient.js";
import { Snapshot } from "./postgres/Snapshot.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const origin = new URL(base).origin;
const credentials =
  "postgresql://reader:page-secret-original@warehouse.example/sales?sslmode=verify-full";
const rotated =
  "postgresql://reader:page-secret-rotated@warehouse.example/sales?sslmode=verify-full";
const retargeted =
  "postgresql://reporter:page-secret-retargeted@reporting.example/reports?sslmode=verify-full";
const unavailable =
  "postgresql://reader:page-secret-rejected@warehouse.example/sales?sslmode=verify-full";
const snapshot = {
  version: 1,
  relations: [],
  enums: [],
  exclusions: []
} satisfies typeof Snapshot.Type;
const encodeDeclarations = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ uses: Schema.Record(Schema.String, PostgresDeclaration) }))
);

// The external database is the only substitute. HTTP admission, company membership,
// encryption, connection state, immutable snapshots and audit writes are production code.
class UnavailableDatabases extends Context.Service<
  UnavailableDatabases,
  Ref.Ref<Readonly<Record<string, true>>>
>()("@patchy/integrations/ConnectionPages.test/UnavailableDatabases") {}
const source = Layer.effect(
  Source.Source,
  Effect.gen(function* () {
    const blocked = yield* UnavailableDatabases;
    const inspect = Effect.fn(function* (value: Redacted.Redacted<string>) {
      const settings = yield* Source.parseCredentials(value);
      if (
        Redacted.value(value) === unavailable ||
        Object.hasOwn(yield* Ref.get(blocked), settings.database)
      ) {
        return yield* new SourceClient.SourceUnavailable({
          stage: "connect",
          cause: Redacted.make(new Error(`driver rejected ${Redacted.value(value)}`))
        });
      }
      return {
        display: {
          host: settings.host,
          port: settings.port,
          database: settings.database,
          role: settings.role
        },
        snapshot
      };
    });
    return Source.Source.of({
      inspect,
      test: Effect.fn(function* (value) {
        return (yield* inspect(value)).display;
      })
    });
  })
).pipe(
  Layer.provideMerge(
    Layer.effect(UnavailableDatabases, Ref.make<Readonly<Record<string, true>>>({}))
  )
);

const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  HttpServer.layerServices,
  ConnectionStore.layer
).pipe(
  Layer.provideMerge(RuntimeLog.layer),
  Layer.provideMerge(source),
  Layer.provideMerge(
    CredentialKeys.layerFromKeys(Redacted.make("test:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="))
  ),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);

const cookie = (user: Users.User) =>
  signedInCookies(
    signSession({
      sub: user.clerkUserId,
      email: user.email,
      name: user.name
    })
  );
const post = (user: Users.User, fields: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { cookie: cookie(user), origin },
  body: new URLSearchParams(fields)
});
const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(ConnectionPages.layer);
  return HttpServerResponse.toWeb(
    yield* app.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
      )
    )
  );
});
const createCompany = Effect.fn(function* (handle: string, name = handle) {
  return yield* (yield* Companies.Companies).create({
    handle,
    name,
    clerkUserId: `user_${handle}_admin`,
    email: `${handle}-admin@example.com`,
    userName: `${handle} Admin`
  });
});
const addUser = Effect.fn(function* (
  owner: { readonly company: Companies.Company; readonly user: Users.User },
  label: string,
  role: Users.Role = "member"
) {
  const companies = yield* Companies.Companies;
  const email = `${owner.company.handle}-${label}@example.com`;
  const invite = yield* companies.createInvite({
    companyId: owner.company.id,
    invitedBy: owner.user.id,
    email,
    role
  });
  return yield* companies.consumeInvite({
    inviteId: invite.id,
    clerkUserId: `user_${owner.company.handle}_${label}`,
    email,
    name: label
  });
});
const connect = Effect.fn(function* (
  user: Users.User,
  handle: string,
  connectionString = credentials,
  description = "Sales warehouse"
) {
  const response = yield* send(
    "/company/connections/connect",
    post(user, {
      handle,
      description,
      credentials: connectionString
    })
  );
  assert.strictEqual(response.status, 303);
  const target = new URL(response.headers.get("location")!, base);
  assert.strictEqual(target.searchParams.get("result"), "connect");
  const connection = (yield* (yield* ConnectionStore.ConnectionStore).list(user.companyId)).find(
    (item) => item.handle === handle
  )!;
  assert.strictEqual(target.pathname, `/company/connections/${connection.id}`);
  return { connection, path: target.pathname };
});
const follow = Effect.fn(function* (response: Response, user: Users.User) {
  assert.strictEqual(response.status, 303);
  const page = yield* send(response.headers.get("location")!, {
    headers: { cookie: cookie(user) }
  });
  assert.strictEqual(page.status, 200);
  return yield* Effect.promise(() => page.text());
});

it.layer(services)("company connection pages", (it) => {
  it.effect(
    "shows only the selected connection's escaped recent calls to admins and never reads the log for members",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const owner = yield* createCompany("connections-audit");
        const member = yield* addUser(owner, "member");
        const { connection, path } = yield* connect(owner.user, "warehouse");
        const other = yield* connect(owner.user, "another");
        const foreign = yield* createCompany("connections-audit-foreign");
        const audit = yield* RuntimeLog.RuntimeLog;
        const sql = `SELECT '</code></pre><script>alert("query")</script>&'`;
        const begin = {
          companyId: owner.company.id,
          patchId: "patch-</code><script>patch</script>",
          versionId: "version-one",
          userId: owner.user.id,
          credentialKind: "session" as const,
          op: "postgres.query",
          resource: null,
          connectionId: connection.id,
          deadlineMs: 15_000
        };
        yield* audit.begin({ ...begin, correlationId: "visible-query", sql });
        yield* audit.finish({
          correlationId: "visible-query",
          outcome: "failure",
          outcomeCode: "invalid_query",
          durationMs: 12,
          rowCount: null
        });
        yield* audit.begin({
          ...begin,
          correlationId: "visible-list",
          op: "postgres.list",
          resource: "public.orders",
          sql: "generated-SQL-not-visible"
        });
        yield* audit.finish({
          correlationId: "visible-list",
          outcome: "success",
          durationMs: 8,
          rowCount: 2
        });
        yield* audit.begin({ ...begin, correlationId: "visible-pending", op: "postgres.get" });
        yield* audit.begin({
          ...begin,
          companyId: foreign.company.id,
          correlationId: "hidden-company",
          sql: "foreign-company-SQL"
        });
        yield* audit.begin({
          ...begin,
          connectionId: other.connection.id,
          correlationId: "hidden-connection",
          sql: "foreign-connection-SQL"
        });
        yield* TestClock.adjust(15_001);
        const response = yield* send(
          `${path}?companyId=${foreign.company.id}&connectionId=${other.connection.id}`,
          {
            headers: { cookie: cookie(owner.user) }
          }
        );
        assert.strictEqual(response.status, 200);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, 'aria-labelledby="connection-calls"');
        assert.include(
          html,
          `<pre class="connection-sql"><code>SELECT '&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(&quot;query&quot;)&lt;/script&gt;&amp;'</code></pre>`
        );
        assert.include(html, "patch-&lt;/code&gt;&lt;script&gt;patch&lt;/script&gt;");
        assert.include(html, "<code>version-one</code>");
        assert.include(html, `<code>${owner.user.id}</code>`);
        assert.include(html, "<dt>Credential kind</dt><dd>session</dd>");
        assert.include(html, "<code>invalid_query</code>");
        assert.include(html, '<time datetime="2026-01-01T00:00:00.000Z">');
        assert.include(html, "12 ms");
        assert.include(html, "2 rows");
        assert.include(html, '<span class="pill">Unknown</span>');
        assert.include(html, "<code>visible-query</code>");
        for (const forbidden of [
          sql,
          "<script>patch</script>",
          "generated-SQL-not-visible",
          "foreign-company-SQL",
          "foreign-connection-SQL",
          "hidden-company",
          "hidden-connection"
        ])
          assert.notInclude(html, forbidden);
        const recent = yield* audit.recent({
          companyId: owner.company.id,
          connectionId: connection.id
        });
        const memberResponse = yield* send(path, { headers: { cookie: cookie(member) } }).pipe(
          Effect.provideService(RuntimeLog.RuntimeLog, {
            ...audit,
            recent: () => Effect.die(new Error("A member must not query the runtime log"))
          })
        );
        assert.strictEqual(memberResponse.status, 200);
        const memberHtml = yield* Effect.promise(() => memberResponse.text());
        assert.notInclude(memberHtml, 'aria-labelledby="connection-calls"');
        assert.notInclude(memberHtml, "visible-query");
        assert.deepStrictEqual(
          (yield* audit.recent({ companyId: owner.company.id, connectionId: connection.id })).map(
            (call) => call.id
          ),
          recent.map((call) => call.id)
        );
      })
  );
  it.effect(
    "shows company-local safe metadata and escapes descriptions, destinations and company names",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany(
          "connections-list",
          'Research <script>alert("company")</script>'
        );
        const member = yield* addUser(owner, "member");
        const description = '<img src=x onerror="alert(1)">';
        const database = '<sales&"archive>';
        const escapedCredentials = `postgresql://reader:page-secret-escaped@warehouse.example/${encodeURIComponent(database)}?sslmode=verify-full`;
        const { path, connection } = yield* connect(
          owner.user,
          "warehouse",
          escapedCredentials,
          description
        );
        const foreign = yield* createCompany("connections-hidden");
        yield* connect(foreign.user, "foreign-warehouse", credentials, "Foreign company data");
        for (const viewer of [owner.user, member]) {
          const response = yield* send("/company/connections", {
            headers: { cookie: cookie(viewer) }
          });
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
          assert.strictEqual(response.headers.get("referrer-policy"), "same-origin");
          assert.include(response.headers.get("content-security-policy")!, "form-action 'self'");
          const list = yield* Effect.promise(() => response.text());
          assert.include(list, "Research &lt;script&gt;alert(&quot;company&quot;)&lt;/script&gt;");
          assert.include(list, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
          assert.include(list, `href="${path}"`);
          assert.notInclude(list, "foreign-warehouse");
          assert.notInclude(list, "Foreign company data");
          assert.notInclude(list, "page-secret-escaped");
          const detail = yield* send(path, { headers: { cookie: cookie(viewer) } });
          const html = yield* Effect.promise(() => detail.text());
          assert.strictEqual(detail.status, 200);
          assert.include(html, "&lt;sales&amp;&quot;archive&gt;");
          assert.include(html, `<dt>Connection ID</dt><dd><code>${connection.id}</code></dd>`);
          assert.notInclude(html, database);
          assert.notInclude(html, escapedCredentials);
          assert.notInclude(html, "page-secret-escaped");
          assert.include(html, 'action="/logout"');
          if (viewer.role === "admin") {
            assert.include(list, 'action="/company/connections/connect"');
            assert.include(html, `action="${path}/rotate"`);
            assert.notMatch(html, /type="password"[^>]*value=/);
          } else {
            assert.notMatch(`${list}${html}`, /<form\b[^>]*action="\/company\/connections/);
          }
        }
      })
  );

  it.effect(
    "completes every connection action and its reverse through forms without changing identity",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-lifecycle");
        const store = yield* ConnectionStore.ConnectionStore;
        const { connection, path } = yield* connect(owner.user, "warehouse");
        const get = () => store.get(owner.company.id, connection.id);
        yield* TestClock.adjust("1 second");
        const tested = yield* follow(yield* send(`${path}/test`, post(owner.user)), owner.user);
        assert.include(tested, 'role="status"');
        assert.notStrictEqual((yield* get()).lastTestedAt, connection.lastTestedAt);

        yield* follow(
          yield* send(`${path}/rotate`, post(owner.user, { credentials: rotated })),
          owner.user
        );
        const rotation = yield* get();
        assert.strictEqual(rotation.id, connection.id);
        assert.strictEqual(rotation.credentialRevision, connection.credentialRevision + 1);
        assert.strictEqual(rotation.metadataRevision, connection.metadataRevision);
        const wrongDestination = yield* send(
          `${path}/rotate`,
          post(owner.user, { credentials: retargeted })
        );
        assert.strictEqual(wrongDestination.status, 409);
        const correction = yield* Effect.promise(() => wrongDestination.text());
        assert.include(correction, "connection_retarget_required");
        assert.include(correction, `action="${path}/retarget"`);
        assert.strictEqual((yield* get()).display.database, "sales");

        yield* follow(
          yield* send(`${path}/retarget`, post(owner.user, { credentials: retargeted })),
          owner.user
        );
        const target = yield* get();
        assert.strictEqual(target.id, connection.id);
        assert.strictEqual(target.display.database, "reports");
        assert.strictEqual(target.display.role, "reporter");
        assert.strictEqual(target.metadataRevision, connection.metadataRevision + 1);
        yield* follow(yield* send(`${path}/refresh`, post(owner.user)), owner.user);
        assert.strictEqual((yield* get()).metadataRevision, target.metadataRevision + 1);

        const updated = yield* follow(
          yield* send(
            `${path}/description`,
            post(owner.user, { description: 'Reports <b>for "everyone"</b>' })
          ),
          owner.user
        );
        assert.include(updated, "Reports &lt;b&gt;for &quot;everyone&quot;&lt;/b&gt;");
        assert.include(updated, 'value="Reports &lt;b&gt;for &quot;everyone&quot;&lt;/b&gt;"');
        yield* follow(
          yield* send(`${path}/description`, post(owner.user, { description: "" })),
          owner.user
        );
        assert.strictEqual((yield* get()).description, "");
        const disconnected = yield* follow(
          yield* send(`${path}/disconnect`, post(owner.user)),
          owner.user
        );
        assert.strictEqual((yield* get()).status, "disconnected");
        assert.include(disconnected, `action="${path}/reconnect"`);
        assert.notInclude(disconnected, `action="${path}/disconnect"`);
        assert.notInclude(disconnected, `action="${path}/refresh"`);
        const testedWhileDisconnected = yield* follow(
          yield* send(`${path}/test`, post(owner.user)),
          owner.user
        );
        assert.include(testedWhileDisconnected, `action="${path}/reconnect"`);
        assert.strictEqual((yield* get()).status, "disconnected");
        const beforeReconnect = yield* get();
        const reconnected = yield* follow(
          yield* send(`${path}/reconnect`, post(owner.user)),
          owner.user
        );
        assert.strictEqual((yield* get()).status, "connected");
        assert.strictEqual((yield* get()).metadataRevision, beforeReconnect.metadataRevision);
        assert.include(reconnected, `action="${path}/disconnect"`);
        assert.notInclude(reconnected, `action="${path}/reconnect"`);
        const deleted = yield* follow(yield* send(`${path}/delete`, post(owner.user)), owner.user);
        assert.notInclude(deleted, `href="${path}"`);
        assert.strictEqual(
          (yield* send(path, { headers: { cookie: cookie(owner.user) } })).status,
          404
        );
        assert.deepStrictEqual(yield* store.list(owner.company.id), []);
      })
  );

  it.effect(
    "keeps previous credentials and metadata after failures and never echoes submitted secrets or driver causes",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-failures");
        const store = yield* ConnectionStore.ConnectionStore;
        const original = credentials.replace("/sales?", "/flaky?");
        const { connection, path } = yield* connect(owner.user, "warehouse", original);
        const badConnect = yield* send(
          "/company/connections/connect",
          post(owner.user, {
            handle: "unavailable",
            description: "Unavailable source",
            credentials: unavailable
          })
        );
        assert.strictEqual(badConnect.status, 503);
        const connectHtml = yield* Effect.promise(() => badConnect.text());
        assert.include(connectHtml, "source_unavailable");
        assert.notInclude(connectHtml, "page-secret-rejected");
        assert.notInclude(connectHtml, "driver rejected");
        assert.include(connectHtml, 'action="/company/connections/connect"');
        for (const action of ["rotate", "retarget"] as const) {
          const response = yield* send(
            `${path}/${action}`,
            post(owner.user, { credentials: unavailable })
          );
          assert.strictEqual(response.status, 503);
          const html = yield* Effect.promise(() => response.text());
          assert.include(html, 'role="alert"');
          assert.notInclude(html, "page-secret-rejected");
          assert.notInclude(html, "page-secret-original");
          assert.notInclude(html, "driver rejected");
          assert.include(html, `action="${path}/${action}"`);
        }
        const blocked = yield* UnavailableDatabases;
        yield* Ref.set(blocked, { flaky: true });
        const failedRefresh = yield* send(`${path}/refresh`, post(owner.user));
        assert.strictEqual(failedRefresh.status, 503);
        const unchanged = yield* store.get(owner.company.id, connection.id);
        assert.strictEqual(unchanged.credentialRevision, connection.credentialRevision);
        assert.strictEqual(unchanged.metadataRevision, connection.metadataRevision);
        assert.strictEqual(unchanged.lastDiscoveredAt, connection.lastDiscoveredAt);
        yield* follow(yield* send(`${path}/disconnect`, post(owner.user)), owner.user);
        assert.strictEqual((yield* send(`${path}/reconnect`, post(owner.user))).status, 503);
        assert.strictEqual(
          (yield* store.get(owner.company.id, connection.id)).status,
          "disconnected"
        );
        yield* Ref.set(blocked, {});
        yield* follow(yield* send(`${path}/reconnect`, post(owner.user)), owner.user);
        assert.strictEqual((yield* store.get(owner.company.id, connection.id)).status, "connected");
        const invalid = yield* send(
          "/company/connections/connect",
          post(owner.user, {
            credentials:
              "postgresql://reader:page-secret-malformed@warehouse.example/sales?sslmode=verify-full"
          })
        );
        assert.strictEqual(invalid.status, 422);
        assert.notInclude(yield* Effect.promise(() => invalid.text()), "page-secret-malformed");
      })
  );

  it.effect(
    "refuses members on every mutation and prevents other companies from selecting a connection",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-authority");
        const member = yield* addUser(owner, "member");
        const other = yield* createCompany("connections-foreign");
        const { connection, path } = yield* connect(owner.user, "warehouse");
        const actions: ReadonlyArray<readonly [string, Record<string, string>]> = [
          [
            "/company/connections/connect",
            { handle: "forged", description: "Forgery", credentials }
          ],
          [`${path}/test`, {}],
          [`${path}/rotate`, { credentials: rotated }],
          [`${path}/retarget`, { credentials: retargeted }],
          [`${path}/refresh`, {}],
          [`${path}/disconnect`, {}],
          [`${path}/reconnect`, {}],
          [`${path}/description`, { description: "Forbidden change" }],
          [`${path}/delete`, {}]
        ];
        for (const [url, fields] of actions) {
          const response = yield* send(
            url,
            post(member, { ...fields, companyId: other.company.id, userId: owner.user.id })
          );
          assert.strictEqual(response.status, 403);
          assert.include(yield* Effect.promise(() => response.text()), "access_denied");
          if (url !== "/company/connections/connect") {
            const foreign = yield* send(
              url,
              post(other.user, { ...fields, companyId: owner.company.id, userId: owner.user.id })
            );
            assert.strictEqual(foreign.status, 404);
            assert.notInclude(yield* Effect.promise(() => foreign.text()), "Sales warehouse");
          }
        }
        assert.strictEqual(
          (yield* send(path, { headers: { cookie: cookie(other.user) } })).status,
          404
        );
        assert.deepStrictEqual(
          yield* (yield* ConnectionStore.ConnectionStore).get(owner.company.id, connection.id),
          connection
        );
        assert.deepStrictEqual(
          yield* (yield* ConnectionStore.ConnectionStore).list(other.company.id),
          []
        );
      })
  );

  it.effect(
    "requires live enrollment and admin status, with the same Origin admission as company forms",
    () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* send("/company/connections")).status, 401);
        const unenrolled = yield* send("/company/connections", {
          headers: {
            cookie: signedInCookies(
              signSession({
                sub: "user_connections_unenrolled",
                email: "connections-unenrolled@example.com",
                name: "Reader"
              })
            )
          }
        });
        assert.strictEqual(unenrolled.status, 303);
        assert.strictEqual(
          new URL(unenrolled.headers.get("location")!, base).searchParams.get("return"),
          "/company/connections"
        );
        const owner = yield* createCompany("connections-admission");
        const secondAdmin = yield* addUser(owner, "other-admin", "admin");
        const { connection, path } = yield* connect(owner.user, "warehouse");
        for (const headers of [
          { origin: "https://attacker.invalid" },
          { origin: "null" },
          { origin: `${origin}/` },
          { "sec-fetch-site": "cross-site" },
          {}
        ]) {
          const response = yield* send(`${path}/disconnect`, {
            method: "POST",
            headers: { cookie: cookie(owner.user), ...headers },
            body: new URLSearchParams()
          });
          assert.strictEqual(response.status, 403);
        }
        const users = yield* Users.Users;
        yield* users.setRole({
          companyId: owner.company.id,
          userId: secondAdmin.id,
          role: "member"
        });
        assert.strictEqual((yield* send(`${path}/disconnect`, post(secondAdmin))).status, 403);
        yield* users.setRole({
          companyId: owner.company.id,
          userId: secondAdmin.id,
          role: "admin"
        });
        yield* users.deactivate({ companyId: owner.company.id, userId: secondAdmin.id });
        assert.strictEqual(
          (yield* send(path, { headers: { cookie: cookie(secondAdmin) } })).status,
          403
        );
        assert.strictEqual((yield* send(`${path}/disconnect`, post(secondAdmin))).status, 403);
        assert.strictEqual(
          (yield* (yield* ConnectionStore.ConnectionStore).get(owner.company.id, connection.id))
            .status,
          "connected"
        );
        yield* users.reactivate({ companyId: owner.company.id, userId: secondAdmin.id });
        yield* follow(yield* send(`${path}/disconnect`, post(secondAdmin)), secondAdmin);
        assert.strictEqual(
          (yield* (yield* ConnectionStore.ConnectionStore).get(owner.company.id, connection.id))
            .status,
          "disconnected"
        );
      })
  );

  it.effect(
    "refuses deletion declared by a stored version even when that version is not active",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-declared");
        const { connection, path } = yield* connect(owner.user, "warehouse");
        const sql = yield* SqlClient.SqlClient;
        const manifest = encodeDeclarations({
          uses: {
            sales: {
              kind: "postgres",
              handle: connection.handle,
              id: connection.id,
              revision: connection.metadataRevision
            }
          }
        });
        yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name, expires_at)
      VALUES ('connection-declared-patch', ${owner.company.id}, ${owner.user.id}, 'Reports', 'reports', now())`;
        yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
      content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
      manifest_version, wire_version, schema_revision, manifest, publish_key, payload_digest,
      publish_response, publish_status)
      VALUES ('connection-declared-version', 'connection-declared-patch', 1, 'connections/declared.html',
        'test', 1, ${DEV_SEED.tokenId}, ${owner.user.id}, 0, 'test', 1, 1, 0,
        ${manifest}::jsonb, 'connection-declared', 'test', '{}'::jsonb, 201)`;
        const response = yield* send(`${path}/delete`, post(owner.user));
        assert.strictEqual(response.status, 409);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, 'role="alert"');
        assert.include(html, `action="${path}/disconnect"`);
        assert.strictEqual(
          (yield* send(path, { headers: { cookie: cookie(owner.user) } })).status,
          200
        );
      })
  );
});
