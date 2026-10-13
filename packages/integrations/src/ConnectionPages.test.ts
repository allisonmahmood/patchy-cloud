import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { PostgresDeclaration } from "@patchy/api";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConnectionPages from "./ConnectionPages.js";
import * as ConnectionStore from "./ConnectionStore.js";
import * as SqlConnectionStore from "./SqlConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as Source from "./postgres/Source.js";
import * as SourceClient from "./postgres/SourceClient.js";
import { Snapshot } from "@patchy/api/postgres-snapshot";

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
const connectPath = "/company/connections/connect/postgres";
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

const events: Analytics.AnalyticsEvent[] = [];
const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  HttpServer.layerServices,
  SqlConnectionStore.layer,
  Layer.succeed(
    Analytics.Analytics,
    Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
  )
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
    connectPath,
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
/** The connection events a company reported, as `[name, principal, connection]`. */
const reported = (companyId: string) =>
  events.flatMap((event) =>
    event.companyId === companyId &&
    (event.name === "connection.connected" || event.name === "connection.deleted")
      ? [
          [
            event.name,
            event.principalId,
            event.properties.connectionId,
            event.properties.integration
          ]
        ]
      : []
  );
const follow = Effect.fn(function* (response: Response, user: Users.User) {
  assert.strictEqual(response.status, 303);
  const page = yield* send(response.headers.get("location")!, {
    headers: { cookie: cookie(user) }
  });
  assert.strictEqual(page.status, 200);
  return yield* Effect.promise(() => page.text());
});

/**
 * Stores version `number` of the company's patch `name`, declaring each connection under its own
 * alias. `current` serves it; `retired` retires the patch.
 */
const storeVersion = Effect.fn(function* (
  owner: { readonly company: Companies.Company; readonly user: Users.User },
  name: string,
  number: number,
  connections: ReadonlyArray<ConnectionStore.Connection>,
  options: { readonly current?: boolean; readonly retired?: boolean } = {}
) {
  const sql = yield* SqlClient.SqlClient;
  const patchId = `${owner.company.handle}-${name}`;
  const versionId = `${patchId}-v${number}`;
  const manifest = encodeDeclarations({
    uses: Object.fromEntries(
      connections.map((connection, index) => [
        `source${index}`,
        {
          kind: "postgres",
          handle: connection.handle,
          id: connection.id,
          revision: connection.metadataRevision
        }
      ])
    )
  });
  yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
    VALUES (${patchId}, ${owner.company.id}, ${owner.user.id}, ${name}, ${name})
    ON CONFLICT (id) DO NOTHING`;
  yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
    content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
    manifest_version, wire_version, schema_revision, manifest, publish_key, payload_digest,
    publish_response, publish_status)
    VALUES (${versionId}, ${patchId}, ${number}, ${`connections/${versionId}.html`},
      'test', 1, ${DEV_SEED.tokenId}, ${owner.user.id}, 0, 'test', 1, 1, 0,
      ${manifest}::jsonb, ${versionId}, 'test', '{}'::jsonb, 201)`;
  if (options.current)
    yield* sql`UPDATE patches SET current_version_id = ${versionId} WHERE id = ${patchId}`;
  if (options.retired) yield* sql`UPDATE patches SET retired_at = now() WHERE id = ${patchId}`;
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
        yield* audit.begin({
          ...begin,
          userId: null,
          effectivePrincipal: "patch</code><script>principal</script>",
          invocationId: "inv_patch_handler",
          correlationId: "visible-handler-error",
          op: "postgres.getMany"
        });
        yield* audit.finish({
          correlationId: "visible-handler-error",
          outcome: "handler_error",
          outcomeCode: "approval_required",
          durationMs: 9,
          rowCount: null
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
          `<code>SELECT '&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(&quot;query&quot;)&lt;/script&gt;&amp;'</code>`
        );
        assert.include(html, "patch-&lt;/code&gt;&lt;script&gt;patch&lt;/script&gt;");
        assert.include(html, "<code>version-one</code>");
        assert.include(html, "<code>invalid_query</code>");
        assert.include(html, '<time datetime="2026-01-01T00:00:00.000Z">');
        assert.include(html, "<code>visible-query</code>");
        // Each call is its row and the Details row after it; a version since reclaimed keeps its ids.
        const rows = html.split("<tr><td><time").slice(1);
        const row = (correlationId: string) =>
          rows.find((item) => item.includes(`<code>${correlationId}</code>`))!;
        assert.include(row("visible-query"), `<td>${owner.user.name}</td>`);
        assert.include(row("visible-query"), "<td>A patch since deleted</td>");
        assert.include(row("visible-list"), "<code>orders.list</code>");
        assert.include(row("visible-list"), "8 ms · 2 rows");
        assert.include(
          row("visible-handler-error"),
          "<td>patch&lt;/code&gt;&lt;script&gt;principal&lt;/script&gt;</td>"
        );
        assert.notInclude(row("visible-handler-error"), "<script>principal</script>");
        assert.include(row("visible-handler-error"), "<code>approval_required</code>");
        assert.include(row("visible-pending"), ">Unknown<");
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
        // A member's pages, including refusals, never read the call log.
        const guarded = {
          ...audit,
          recent: () => Effect.die(new Error("A member must not query the runtime log")),
          latest: () => Effect.die(new Error("A member must not query the runtime log"))
        };
        for (const [url, options, status] of [
          [path, {}, 200],
          ["/company/connections", {}, 200],
          [`${path}/disconnect`, {}, 403],
          [`${path}/disconnect`, post(member), 403],
          [connectPath, post(member), 403]
        ] as const) {
          const memberResponse = yield* send(url, {
            headers: { cookie: cookie(member) },
            ...options
          }).pipe(Effect.provideService(RuntimeLog.RuntimeLog, guarded));
          assert.strictEqual(memberResponse.status, status);
          const memberHtml = yield* Effect.promise(() => memberResponse.text());
          assert.notInclude(memberHtml, 'aria-labelledby="connection-calls"');
          assert.notInclude(memberHtml, "visible-query");
          assert.notInclude(memberHtml, "Last call");
        }
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
          assert.include(list, "&lt;sales&amp;&quot;archive&gt; on warehouse.example");
          assert.include(html, `patchy add postgres/${connection.handle}`);
          assert.notInclude(html, database);
          assert.notInclude(html, escapedCredentials);
          assert.notInclude(html, "page-secret-escaped");
          assert.include(html, 'action="/logout"');
          for (const document of [list, html])
            assert.include(document, '<a href="/company/connections" aria-current="page">');
          const rotate = yield* send(`${path}/rotate`, { headers: { cookie: cookie(viewer) } });
          const rotateHtml = yield* Effect.promise(() => rotate.text());
          if (viewer.role === "admin") {
            assert.include(list, 'href="/company/connections/connect"');
            assert.include(html, `href="${path}/rotate"`);
            assert.strictEqual(rotate.status, 200);
            assert.include(rotateHtml, `action="${path}/rotate"`);
            assert.include(rotateHtml, 'type="password"');
            assert.notMatch(rotateHtml, /type="password"[^>]*value=/);
          } else {
            assert.strictEqual(rotate.status, 403);
            assert.notMatch(
              `${list}${html}${rotateHtml}`,
              /<form\b[^>]*action="\/company\/connections/
            );
            assert.notInclude(`${list}${html}`, `href="${path}/rotate"`);
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
        const wrongDestination = yield* send(
          `${path}/rotate`,
          post(owner.user, { credentials: retargeted })
        );
        assert.strictEqual(wrongDestination.status, 409);
        const correction = yield* Effect.promise(() => wrongDestination.text());
        assert.include(correction, "connection_retarget_required");
        assert.include(correction, `action="${path}/rotate"`);
        assert.include(correction, `href="${path}/retarget"`);
        assert.strictEqual((yield* get()).display.database, "sales");

        yield* follow(
          yield* send(`${path}/retarget`, post(owner.user, { credentials: retargeted })),
          owner.user
        );
        const target = yield* get();
        assert.strictEqual(target.id, connection.id);
        assert.strictEqual(target.display.database, "reports");
        assert.strictEqual(target.display.role, "reporter");
        yield* follow(yield* send(`${path}/refresh`, post(owner.user)), owner.user);

        const updated = yield* follow(
          yield* send(
            `${path}/description`,
            post(owner.user, { description: 'Reports <b>for "everyone"</b>' })
          ),
          owner.user
        );
        assert.include(updated, "Reports &lt;b&gt;for &quot;everyone&quot;&lt;/b&gt;");
        const editing = yield* send(`${path}/description`, {
          headers: { cookie: cookie(owner.user) }
        });
        assert.include(
          yield* Effect.promise(() => editing.text()),
          'value="Reports &lt;b&gt;for &quot;everyone&quot;&lt;/b&gt;"'
        );
        const tooLong = yield* send(
          `${path}/description`,
          post(owner.user, { description: `Kept ${"x".repeat(500)}` })
        );
        assert.strictEqual(tooLong.status, 400);
        assert.include(
          yield* Effect.promise(() => tooLong.text()),
          `value="Kept ${"x".repeat(500)}"`
        );
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
        assert.notInclude(disconnected, `${path}/disconnect"`);
        assert.notInclude(disconnected, `${path}/refresh"`);
        const testedWhileDisconnected = yield* follow(
          yield* send(`${path}/test`, post(owner.user)),
          owner.user
        );
        assert.include(testedWhileDisconnected, `action="${path}/reconnect"`);
        assert.strictEqual((yield* get()).status, "disconnected");
        const reconnected = yield* follow(
          yield* send(`${path}/reconnect`, post(owner.user)),
          owner.user
        );
        assert.strictEqual((yield* get()).status, "connected");
        assert.include(reconnected, `href="${path}/disconnect"`);
        assert.notInclude(reconnected, `${path}/reconnect"`);
        const confirming = yield* send(`${path}/delete`, {
          headers: { cookie: cookie(owner.user) }
        });
        assert.strictEqual(confirming.status, 200);
        assert.include(yield* Effect.promise(() => confirming.text()), `action="${path}/delete"`);
        const deleted = yield* follow(yield* send(`${path}/delete`, post(owner.user)), owner.user);
        assert.notInclude(deleted, `href="${path}"`);
        assert.strictEqual(
          (yield* send(path, { headers: { cookie: cookie(owner.user) } })).status,
          404
        );
        assert.deepStrictEqual(yield* store.list(owner.company.id), []);
        assert.deepStrictEqual(reported(owner.company.id), [
          ["connection.connected", owner.user.id, connection.id, "postgres"],
          ["connection.deleted", owner.user.id, connection.id, "postgres"]
        ]);
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
          connectPath,
          post(owner.user, {
            handle: "unavailable",
            description: "Unavailable source",
            credentials: unavailable
          })
        );
        assert.strictEqual(badConnect.status, 503);
        const connectHtml = yield* Effect.promise(() => badConnect.text());
        assert.include(connectHtml, "source_unavailable");
        assert.include(connectHtml, '<a href="/company/connections" aria-current="page">');
        assert.notInclude(connectHtml, "page-secret-rejected");
        assert.notInclude(connectHtml, "driver rejected");
        assert.include(connectHtml, `action="${connectPath}"`);
        assert.include(connectHtml, 'value="unavailable"');
        assert.include(connectHtml, 'value="Unavailable source"');
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
          connectPath,
          post(owner.user, {
            credentials:
              "postgresql://reader:page-secret-malformed@warehouse.example/sales?sslmode=verify-full"
          })
        );
        assert.strictEqual(invalid.status, 422);
        assert.notInclude(yield* Effect.promise(() => invalid.text()), "page-secret-malformed");
        assert.deepStrictEqual(reported(owner.company.id), [
          ["connection.connected", owner.user.id, connection.id, "postgres"]
        ]);
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
          [connectPath, { handle: "forged", description: "Forgery", credentials }],
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
          if (url !== connectPath) {
            const foreign = yield* send(
              url,
              post(other.user, { ...fields, companyId: owner.company.id, userId: owner.user.id })
            );
            assert.strictEqual(foreign.status, 404);
            const foreignHtml = yield* Effect.promise(() => foreign.text());
            assert.notInclude(foreignHtml, "Sales warehouse");
            assert.notMatch(foreignHtml, /<nav\b/);
            assert.include(foreignHtml, 'action="/logout"');
          }
        }
        for (const page of [path, `${path}/rotate`, `${path}/delete`])
          assert.strictEqual(
            (yield* send(page, { headers: { cookie: cookie(other.user) } })).status,
            404
          );
        for (const page of [connectPath, `${path}/retarget`, `${path}/description`])
          assert.strictEqual(
            (yield* send(page, { headers: { cookie: cookie(member) } })).status,
            403
          );
        assert.deepStrictEqual(
          yield* (yield* ConnectionStore.ConnectionStore).get(owner.company.id, connection.id),
          connection
        );
        assert.deepStrictEqual(
          yield* (yield* ConnectionStore.ConnectionStore).list(other.company.id),
          []
        );
        assert.deepStrictEqual(reported(owner.company.id), [
          ["connection.connected", owner.user.id, connection.id, "postgres"]
        ]);
        assert.deepStrictEqual(reported(other.company.id), []);
      })
  );

  it.effect("requires current admin status and the company forms' Origin admission", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("connections-admission");
      const secondAdmin = yield* addUser(owner, "other-admin", "admin");
      const { connection, path } = yield* connect(owner.user, "warehouse");
      // RequireSession.sameOrigin owns the full Origin matrix; one forgery proves the wiring.
      const forged = yield* send(`${path}/disconnect`, {
        method: "POST",
        headers: { cookie: cookie(owner.user), origin: "https://attacker.invalid" },
        body: new URLSearchParams()
      });
      assert.strictEqual(forged.status, 403);
      const users = yield* Users.Users;
      yield* users.setRole({
        companyId: owner.company.id,
        userId: secondAdmin.id,
        role: "member"
      });
      assert.strictEqual((yield* send(`${path}/disconnect`, post(secondAdmin))).status, 403);
      assert.strictEqual(
        (yield* (yield* ConnectionStore.ConnectionStore).get(owner.company.id, connection.id))
          .status,
        "connected"
      );
    })
  );

  it.effect(
    "refuses deletion declared by a stored version even when that version is not active",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-declared");
        const { connection, path } = yield* connect(owner.user, "warehouse");
        yield* storeVersion(owner, "reports", 1, [connection]);
        const response = yield* send(`${path}/delete`, post(owner.user));
        assert.strictEqual(response.status, 409);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, 'role="alert"');
        assert.include(html, `href="${path}/disconnect"`);
        assert.notInclude(html, `href="${path}/delete"`);
        // A stale link to the confirmation says why instead of offering Delete.
        const stale = yield* send(`${path}/delete`, { headers: { cookie: cookie(owner.user) } });
        assert.strictEqual(stale.status, 409);
        assert.include(yield* Effect.promise(() => stale.text()), "connection_in_use");
        const index = yield* send("/company/connections", {
          headers: { cookie: cookie(owner.user) }
        });
        assert.include(
          yield* Effect.promise(() => index.text()),
          "None now; older versions declare it"
        );
        assert.strictEqual(
          (yield* send(path, { headers: { cookie: cookie(owner.user) } })).status,
          200
        );
        // The refused deletion rolled back and reported nothing.
        assert.deepStrictEqual(reported(owner.company.id), [
          ["connection.connected", owner.user.id, connection.id, "postgres"]
        ]);
      })
  );
  it.effect(
    "names the live patches using a connection once each, by the rule that guards deletion",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-usage");
        const foreign = yield* createCompany("connections-usage-foreign");
        const warehouse = yield* connect(owner.user, "warehouse");
        const archive = yield* connect(owner.user, "archive");
        const spare = yield* connect(owner.user, "spare");
        // Two aliases in one served version count its patch once.
        yield* storeVersion(owner, "revenue", 1, [warehouse.connection, warehouse.connection], {
          current: true
        });
        // An older version keeps archive declared after the served one dropped it.
        yield* storeVersion(owner, "reports", 1, [archive.connection]);
        yield* storeVersion(owner, "reports", 2, [warehouse.connection], { current: true });
        // A retired patch's served version declares warehouse without using it.
        yield* storeVersion(owner, "old-board", 1, [warehouse.connection], {
          current: true,
          retired: true
        });
        // Another company's version naming spare's id declares nothing here.
        yield* storeVersion(foreign, "copycat", 1, [spare.connection], { current: true });
        const usage = yield* (yield* ConnectionStore.ConnectionStore).usage(owner.company.id);
        assert.deepStrictEqual(usage.get(warehouse.connection.id), {
          usedBy: ["reports", "revenue"],
          declared: true
        });
        assert.deepStrictEqual(usage.get(archive.connection.id), { usedBy: [], declared: true });
        assert.isUndefined(usage.get(spare.connection.id));

        const read = Effect.fn(function* (path: string) {
          const response = yield* send(path, { headers: { cookie: cookie(owner.user) } });
          return yield* Effect.promise(() => response.text());
        });
        const index = yield* read("/company/connections");
        const row = (path: string) =>
          index.split("<tr><td>").find((item) => item.includes(`href="${path}"`))!;
        assert.include(row(warehouse.path), "<td>2 patches</td>");
        assert.include(row(archive.path), "None now; older versions declare it");
        assert.include(row(spare.path), '<span class="supporting-text">None</span>');
        const detail = yield* read(warehouse.path);
        assert.include(
          detail,
          '<dt>Used by</dt><dd><a href="/patches/reports">reports</a> and <a href="/patches/revenue">revenue</a></dd>'
        );
        assert.notInclude(detail, `href="${warehouse.path}/delete"`);
        assert.include(yield* read(spare.path), `href="${spare.path}/delete"`);
        const disconnecting = yield* read(`${warehouse.path}/disconnect`);
        assert.include(disconnecting, "These patches lose access on their next call:");
        assert.include(disconnecting, '<li><a href="/patches/revenue">revenue</a></li>');
        assert.notInclude(disconnecting, "old-board");
      })
  );

  it.effect(
    "starts an empty company from the catalogue and tells members which admins can connect",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-empty", "Empty Co");
        const member = yield* addUser(owner, "member");
        yield* addUser(owner, "second-admin", "admin");
        const read = Effect.fn(function* (user: Users.User, path: string) {
          const response = yield* send(path, { headers: { cookie: cookie(user) } });
          return { status: response.status, html: yield* Effect.promise(() => response.text()) };
        });
        const admin = yield* read(owner.user, "/company/connections");
        assert.include(admin.html, "Connect your first source");
        assert.include(admin.html, `href="${connectPath}"`);
        const empty = yield* read(member, "/company/connections");
        assert.include(empty.html, "Nothing is connected yet");
        assert.include(empty.html, `At Empty Co that's ${owner.user.name} and second-admin.`);
        assert.notInclude(empty.html, `href="${connectPath}"`);
        const catalogue = yield* read(owner.user, "/company/connections/connect");
        assert.strictEqual(catalogue.status, 200);
        assert.include(catalogue.html, `href="${connectPath}"`);
        assert.notInclude((yield* read(member, "/company/connections/connect")).html, connectPath);
        const form = yield* read(owner.user, connectPath);
        assert.strictEqual(form.status, 200);
        assert.include(form.html, `action="${connectPath}"`);
        assert.include(
          form.html,
          '<label class="field-prefix" for="connection-handle">postgres/</label>'
        );
        assert.strictEqual(
          (yield* read(owner.user, "/company/connections/connect/gmail")).status,
          404
        );
      })
  );
});
