import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
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
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import { PostgresDeclaration } from "@patchy/api";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, signedInCookies, signSession } from "@patchy/auth/testing";
import { Teams, Companies, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConnectionPages from "./ConnectionPages.js";
import * as ConnectionStore from "./ConnectionStore.js";
import * as SqlConnectionStore from "./SqlConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as Source from "./postgres/Source.js";
import * as SourceClient from "./postgres/SourceClient.js";
import * as PostHogDouble from "./test/posthog.js";
import * as PidgeonSource from "./pidgeon/Source.js";
import * as AttioSource from "./attio/Source.js";
import * as ImapTest from "./test/imap.js";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import { NodeCryptography } from "@patchy/core";
import * as PatchVisibility from "./PatchVisibility.js";
import * as PatchVisibilityTest from "./test/patchVisibility.js";

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
const connectPath = "/settings/integrations/connect/postgres";
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

/** One PostHog project the connect walkthrough can reach, with a key limited to it. */
const posthogProject = {
  region: "eu",
  id: 4321,
  key: "phx_connectionPagesKey01",
  events: [
    { name: "$pageview", description: "Automatically captured page views." },
    { name: "patch.opened" }
  ],
  eventProperties: [{ name: "$browser", property_type: "String" }],
  personProperties: [{ name: "email", property_type: "String", description: "Their address" }]
} satisfies PostHogDouble.Project;
// The same project behind a second key, for replacing the key without moving the project, and a
// key whose project PostHog no longer finds.
const projects = PostHogDouble.project(posthogProject, {
  ...posthogProject,
  key: "phx_connectionPagesKey02"
});
const posthog = PostHogDouble.make((request) =>
  request.authorization === "Bearer phx_projectGoneKey0001"
    ? PostHogDouble.json(404, { type: "invalid_request", code: "not_found", detail: "Not found." })
    : projects(request)
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
  Layer.provideMerge(posthog.layer),
  Layer.provideMerge(PidgeonSource.layer),
  Layer.provideMerge(AttioSource.layer),
  Layer.provideMerge(ImapTest.offline),
  Layer.provideMerge(
    CredentialKeys.layerFromKeys(Redacted.make("test:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="))
  ),
  Layer.provideMerge(PatchVisibilityTest.layer),
  Layer.provideMerge(Teams.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(NodeCryptography.layer)
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
  assert.strictEqual(target.pathname, `/settings/integrations/${connection.id}`);
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
      'test', 1, ${DEV_SEED.tokenId}, ${owner.user.id}, 1, 'test', 1, 1, 0,
      ${manifest}::jsonb, ${versionId}, 'test', '{}'::jsonb, 201)`;
  if (options.current)
    yield* sql`UPDATE patches SET current_version_id = ${versionId} WHERE id = ${patchId}`;
  if (options.retired) yield* sql`UPDATE patches SET retired_at = now() WHERE id = ${patchId}`;
});

/** A patch of the owner's company with no version, for calls recorded from it. */
const storePatch = Effect.fn(function* (
  owner: { readonly company: Companies.Company; readonly user: Users.User },
  id: string,
  name: string
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
    VALUES (${id}, ${owner.company.id}, ${owner.user.id}, ${name}, ${name})`;
});

it.layer(services)("company connection pages", (it) => {
  it.effect(
    "narrows an audience as an admin, past a warning naming the live patches it cuts off",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connection-audience-page");
        const member = yield* addUser(owner, "reader");
        const { connection, path } = yield* connect(owner.user, "audience-page");
        const team = yield* (yield* Teams.Teams).create({
          companyId: owner.company.id,
          actorId: owner.user.id,
          name: "Design & Engineering"
        });
        // A live patch whose owner isn't on the team.
        yield* storeVersion({ company: owner.company, user: member }, "readers-desk", 1, [
          connection
        ]);
        yield* SqlClient.SqlClient.use(
          (sql) =>
            sql`UPDATE patches SET current_version_id = ${`${owner.company.handle}-readers-desk-v1`} WHERE id = ${`${owner.company.handle}-readers-desk`}`
        );
        const store = yield* ConnectionStore.ConnectionStore;
        const audience = store.audience(owner.company.id, connection.id);
        const narrow = { audience: "teams", teamIds: team.id };
        assert.equal((yield* send(`${path}/audience`, post(member, narrow))).status, 403);
        // A refused save draws the form again as it was submitted.
        const refused = yield* send(`${path}/audience`, post(owner.user, { audience: "teams" }));
        assert.equal(refused.status, 422);
        assert.match(
          yield* Effect.promise(() => refused.text()),
          /name="audience" value="teams"[^>]* checked/
        );
        const warned = yield* send(`${path}/audience`, post(owner.user, narrow));
        assert.equal(warned.status, 200);
        assert.include(yield* Effect.promise(() => warned.text()), "/patches/readers-desk");
        assert.deepEqual(yield* audience, { kind: "company" });
        assert.equal(
          (yield* send(`${path}/audience`, post(owner.user, { ...narrow, acknowledged: "1" })))
            .status,
          303
        );
        assert.deepEqual(yield* audience, { kind: "teams", teamIds: [team.id] });
        // Saving it again cuts nobody off who could build with it, so it saves at once.
        assert.equal((yield* send(`${path}/audience`, post(owner.user, narrow))).status, 303);
        assert.equal((yield* send(path, { headers: { cookie: cookie(member) } })).status, 404);
        const listed = yield* send("/settings/integrations", {
          headers: { cookie: cookie(member) }
        });
        assert.notInclude(yield* Effect.promise(() => listed.text()), "postgres/audience-page");
        yield* (yield* Teams.Teams).setMemberships({
          companyId: owner.company.id,
          actorId: owner.user.id,
          teamId: team.id,
          userIds: [member.id],
          added: true
        });
        assert.equal((yield* send(path, { headers: { cookie: cookie(member) } })).status, 200);
        // Widening cuts nobody off, so it saves at once.
        assert.equal(
          (yield* send(`${path}/audience`, post(owner.user, { audience: "company" }))).status,
          303
        );
        assert.deepEqual(yield* audience, { kind: "company" });
      })
  );
  it.effect("lets only an admin block guests from a connection, and shows everyone which", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("connections-blocking");
      const member = yield* addUser(owner, "member");
      const { connection, path } = yield* connect(owner.user, "warehouse");
      const store = yield* ConnectionStore.ConnectionStore;
      const blocked = Effect.map(
        store.get(owner.company.id, connection.id),
        (row) => row.blockGuests
      );
      const page = (user: Users.User, tab = "") =>
        Effect.flatMap(send(`${path}${tab}`, { headers: { cookie: cookie(user) } }), (response) =>
          Effect.promise(() => response.text())
        );

      assert.strictEqual((yield* send(`${path}/block-guests`, post(member))).status, 403);
      assert.isFalse(yield* blocked);
      // Settings' guests switch lands back on Settings, switched off.
      const switched = yield* follow(
        yield* send(`${path}/block-guests`, post(owner.user)),
        owner.user
      );
      assert.include(switched, "Guests blocked.");
      assert.include(switched, 'aria-checked="false"');
      assert.isTrue(yield* blocked);
      // A member reads that guests are blocked, with no way to change it.
      const seen = yield* page(member);
      assert.match(seen, /<dt>Guests<\/dt><dd>Blocked<\/dd>/);
      assert.notInclude(seen, `${path}/allow-guests`);
      assert.include(yield* page(owner.user, "/settings"), `${path}/allow-guests`);

      yield* follow(yield* send(`${path}/allow-guests`, post(owner.user)), owner.user);
      assert.isFalse(yield* blocked);
    })
  );
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
        yield* storePatch(owner, begin.patchId, "audited");
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
        // A read from `patchy dev`: a machine's key, no patch.
        yield* audit.begin({
          ...begin,
          credentialKind: "machine",
          machine: { id: "tok_laptop", name: "Laptop <one>" },
          patchId: null,
          versionId: null,
          correlationId: "visible-dev",
          op: "posthog.query",
          resource: "dailyViews"
        });
        yield* audit.finish({
          correlationId: "visible-dev",
          outcome: "success",
          durationMs: 40,
          rowCount: 3
        });
        // A read by the owner's worker agent, named by a client the owner approved.
        yield* audit.begin({
          ...begin,
          credentialKind: "agent",
          agent: { name: "Claude <Code>" },
          correlationId: "visible-agent",
          op: "postgres.list",
          resource: "public.orders"
        });
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
          `${path}/calls?companyId=${foreign.company.id}&connectionId=${other.connection.id}`,
          {
            headers: { cookie: cookie(owner.user) }
          }
        );
        assert.strictEqual(response.status, 200);
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, '<table class="table table-compact table-wide" aria-label="Calls">');
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
        assert.include(
          row("visible-dev"),
          '<td><span class="badge">Dev</span> patchy dev on Laptop &lt;one&gt;</td>'
        );
        assert.include(row("visible-dev"), `<td>${owner.user.name}</td>`);
        assert.include(row("visible-dev"), "<code>query dailyViews</code>");
        assert.include(
          row("visible-dev"),
          "The computer Laptop &lt;one&gt;, reading the real connection while building a patch"
        );
        assert.notInclude(row("visible-dev"), "Patch / version");
        assert.include(row("visible-agent"), `<td>${owner.user.name} via Claude &lt;Code&gt;</td>`);
        for (const forbidden of [
          sql,
          "Claude <Code>",
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
          connectionId: connection.id,
          patchIds: [begin.patchId]
        });
        // A member's pages, including refusals, never read the call log.
        const guarded = {
          ...audit,
          recent: () => Effect.die(new Error("A member must not query the runtime log")),
          latest: () => Effect.die(new Error("A member must not query the runtime log"))
        };
        for (const [url, options, status] of [
          [path, {}, 200],
          ["/settings/integrations", {}, 200],
          [`${path}/calls`, {}, 403],
          [`${path}/settings`, {}, 403],
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
          assert.notInclude(memberHtml, 'aria-label="Calls"');
          assert.notInclude(memberHtml, "visible-query");
          assert.notInclude(memberHtml, "Last call");
        }
        assert.deepStrictEqual(
          (yield* audit.recent({
            companyId: owner.company.id,
            connectionId: connection.id,
            patchIds: [begin.patchId]
          })).map((call) => call.id),
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
          const response = yield* send("/settings/integrations", {
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
          assert.include(html, `patchy add postgres/${connection.handle}`);
          assert.notInclude(html, database);
          assert.notInclude(html, escapedCredentials);
          assert.notInclude(html, "page-secret-escaped");
          assert.include(html, 'action="/logout"');
          for (const document of [list, html])
            assert.include(
              document,
              '<a class="app-place" href="/settings/integrations" aria-current="page">'
            );
          const rotate = yield* send(`${path}/rotate`, { headers: { cookie: cookie(viewer) } });
          const rotateHtml = yield* Effect.promise(() => rotate.text());
          if (viewer.role === "admin") {
            const settings = yield* send(`${path}/settings`, {
              headers: { cookie: cookie(viewer) }
            });
            assert.include(
              yield* Effect.promise(() => settings.text()),
              "&lt;sales&amp;&quot;archive&gt; on warehouse.example"
            );
            assert.include(list, 'href="/settings/integrations/connect"');
            assert.include(html, `href="${path}/rotate"`);
            assert.strictEqual(rotate.status, 200);
            assert.include(rotateHtml, `action="${path}/rotate"`);
            assert.include(rotateHtml, 'type="password"');
            // The dialog's one field takes focus as it opens.
            assert.match(rotateHtml, /id="connection-credentials"[^>]*autofocus/);
            assert.notMatch(rotateHtml, /type="password"[^>]*value=/);
          } else {
            assert.strictEqual(rotate.status, 403);
            assert.notMatch(
              `${list}${html}${rotateHtml}`,
              /<form\b[^>]*action="\/settings\/integrations/
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
        const get = () =>
          store.get(owner.company.id, connection.id).pipe(
            Effect.map((found) => {
              if (found.integration !== "postgres") return assert.fail("A Postgres connection");
              return found;
            })
          );
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
        const tooLongHtml = yield* Effect.promise(() => tooLong.text());
        assert.include(tooLongHtml, `value="Kept ${"x".repeat(500)}"`);
        assert.include(
          tooLongHtml,
          'aria-describedby="connection-description-hint connection-description-error" aria-invalid="true"'
        );
        assert.match(tooLongHtml, /id="connection-description"[^>]*autofocus/);
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
        // A Pause or Disconnect that fails draws its dialog again, its refusal in focus.
        const failing = {
          ...store,
          disconnect: () => Effect.fail(new ConnectionStore.ConnectionMutationUnavailable({})),
          delete: () => Effect.fail(new ConnectionStore.ConnectionMutationUnavailable({}))
        };
        for (const action of ["disconnect", "delete"] as const) {
          const failed = yield* send(`${path}/${action}`, post(owner.user)).pipe(
            Effect.provideService(ConnectionStore.ConnectionStore, failing)
          );
          assert.strictEqual(failed.status, 503);
          const failedHtml = yield* Effect.promise(() => failed.text());
          assert.include(failedHtml, 'role="dialog"');
          assert.include(failedHtml, `action="${path}/${action}"`);
          assert.include(failedHtml, "connection_mutation_unavailable");
          assert.include(failedHtml, '<div tabindex="-1" autofocus>');
        }
        assert.strictEqual((yield* get()).status, "connected");
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
        assert.include(
          connectHtml,
          '<a class="app-place" href="/settings/integrations" aria-current="page">'
        );
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
        // A refusal about one field replaces that field's hint, keeping what was typed.
        const taken = yield* send(
          connectPath,
          post(owner.user, { handle: "warehouse", description: "Again", credentials })
        );
        assert.strictEqual(taken.status, 409);
        const takenHtml = yield* Effect.promise(() => taken.text());
        assert.match(
          takenHtml,
          /id="connection-handle" aria-describedby="connection-handle-hint connection-handle-error" aria-invalid="true" name="handle" value="warehouse"[^>]*autofocus/
        );
        assert.include(takenHtml, '<p class="field-error" id="connection-handle-error">');
        assert.include(takenHtml, "(connection_handle_taken)");
        assert.include(takenHtml, 'value="Again"');
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
            // Another company's connection reads as missing, inside the app.
            assert.include(foreignHtml, "connection_not_found");
            assert.include(
              foreignHtml,
              '<a class="app-place" href="/settings/integrations" aria-current="page">'
            );
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
        assert.include(html, "Stored versions of reports still declare it");
        assert.include(html, `href="${path}/disconnect"`);
        assert.notInclude(html, `href="${path}/delete"`);
        // A stale link to the confirmation says why instead of offering Delete.
        const stale = yield* send(`${path}/delete`, { headers: { cookie: cookie(owner.user) } });
        assert.strictEqual(stale.status, 409);
        assert.include(yield* Effect.promise(() => stale.text()), "connection_in_use");
        const index = yield* send("/settings/integrations", {
          headers: { cookie: cookie(owner.user) }
        });
        assert.include(
          yield* Effect.promise(() => index.text()),
          'None live <span class="meta">· 1 older version</span>'
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
        const ledger = yield* connect(owner.user, "ledger");
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
        // Only a retired patch declares ledger.
        yield* storeVersion(owner, "old-ledger", 1, [ledger.connection], {
          current: true,
          retired: true
        });
        // Another company's version naming spare's id declares nothing here.
        yield* storeVersion(foreign, "copycat", 1, [spare.connection], { current: true });
        const usage = yield* (yield* ConnectionStore.ConnectionStore).usage(owner.company.id);
        const declared = { olderVersions: 0, retired: 0, deleted: 0, disabled: 0, declared: true };
        // Every other patch that declares it is named, for what keeps it from being disconnected.
        assert.deepStrictEqual(usage.get(warehouse.connection.id), {
          ...declared,
          usedBy: ["reports", "revenue"],
          retired: 1,
          declaredBy: ["old-board"]
        });
        assert.deepStrictEqual(usage.get(archive.connection.id), {
          ...declared,
          usedBy: [],
          olderVersions: 1,
          declaredBy: ["reports"]
        });
        assert.deepStrictEqual(usage.get(ledger.connection.id), {
          ...declared,
          usedBy: [],
          retired: 1,
          declaredBy: ["old-ledger"]
        });
        assert.isUndefined(usage.get(spare.connection.id));

        const read = Effect.fn(function* (path: string) {
          const response = yield* send(path, { headers: { cookie: cookie(owner.user) } });
          return yield* Effect.promise(() => response.text());
        });
        const index = yield* read("/settings/integrations");
        const row = (path: string) =>
          index.split("<tr><td>").find((item) => item.includes(`href="${path}"`))!;
        assert.include(row(warehouse.path), '<td class="hide-sm">reports and 1 more</td>');
        // No sentence in a row: who still declares it, in Patchy's words.
        assert.include(
          row(archive.path),
          '<td class="hide-sm">None live <span class="meta">· 1 older version</span></td>'
        );
        assert.include(
          row(ledger.path),
          '<td class="hide-sm">None live <span class="meta">· 1 retired</span></td>'
        );
        assert.include(row(spare.path), '<span class="meta">None</span>');
        const detail = yield* read(warehouse.path);
        assert.include(
          detail,
          '<dt>Used by</dt><dd><a href="/patches/reports">reports</a> and <a href="/patches/revenue">revenue</a></dd>'
        );
        assert.notInclude(detail, `href="${warehouse.path}/delete"`);
        assert.include(yield* read(`${spare.path}/settings`), `href="${spare.path}/delete"`);
        assert.include(
          yield* read(ledger.path),
          '<dt>Used by</dt><dd>None live <span class="meta">· 1 retired</span></dd>'
        );
        const disconnecting = yield* read(`${warehouse.path}/disconnect`);
        assert.include(disconnecting, "These patches lose access on their next call:");
        const dialog = disconnecting.slice(disconnecting.indexOf('id="connection-dialog"'));
        assert.include(dialog, '<a class="row-link" href="/patches/revenue">revenue</a>');
        assert.notInclude(dialog, "old-board");
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
        const admin = yield* read(owner.user, "/settings/integrations");
        assert.include(admin.html, '<h1 class="title">Integrations</h1>');
        assert.include(admin.html, "Nothing is connected yet");
        assert.include(admin.html, `href="${connectPath}"`);
        const empty = yield* read(member, "/settings/integrations");
        assert.include(
          empty.html,
          `Only admins connect integrations. Admins: ${owner.user.name} and second-admin.`
        );
        assert.include(empty.html, "Something else");
        assert.notInclude(empty.html, `href="${connectPath}"`);
        const catalogue = yield* read(owner.user, "/settings/integrations/connect");
        assert.strictEqual(catalogue.status, 200);
        assert.include(catalogue.html, `href="${connectPath}"`);
        assert.notInclude(
          (yield* read(member, "/settings/integrations/connect")).html,
          connectPath
        );
        const form = yield* read(owner.user, connectPath);
        assert.strictEqual(form.status, 200);
        assert.include(form.html, `action="${connectPath}"`);
        assert.include(
          form.html,
          '<label class="field-prefix" for="connection-handle">postgres/</label>'
        );
        assert.strictEqual(
          (yield* read(owner.user, "/settings/integrations/connect/gmail")).status,
          404
        );
        // Cancel returns to where the integration was chosen: the empty Integrations page, which
        // lists them, and once something is connected, the catalogue behind its button.
        const cancel = (html: string) =>
          html.match(/<a class="btn btn-quiet" href="([^"]+)">Cancel<\/a>/)?.[1];
        assert.strictEqual(cancel(form.html), "/settings/integrations");
        yield* connect(owner.user, "warehouse");
        assert.strictEqual(
          cancel((yield* read(owner.user, connectPath)).html),
          "/settings/integrations/connect"
        );
        const refused = yield* send(
          connectPath,
          post(owner.user, { handle: "x", description: "", credentials })
        );
        assert.strictEqual(refused.status, 400);
        assert.strictEqual(
          cancel(yield* Effect.promise(() => refused.text())),
          "/settings/integrations/connect"
        );
      })
  );
  it.effect("names a patch's guest from another company in recent calls", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("connections-guests");
      const guest = yield* createCompany("connections-guests-home");
      const { connection, path } = yield* connect(owner.user, "warehouse");
      const audit = yield* RuntimeLog.RuntimeLog;
      yield* storePatch(owner, "guest-patch", "guested");
      yield* audit.begin({
        companyId: owner.company.id,
        patchId: "guest-patch",
        versionId: "guest-version",
        userId: guest.user.id,
        credentialKind: "session",
        op: "postgres.list",
        resource: "public.orders",
        connectionId: connection.id,
        correlationId: "guest-call",
        deadlineMs: 15_000
      });
      const response = yield* send(`${path}/calls`, { headers: { cookie: cookie(owner.user) } });
      const html = yield* Effect.promise(() => response.text());
      const row = html
        .split("<tr><td><time")
        .find((item) => item.includes("<code>guest-call</code>"));
      assert.include(row, `<td>${guest.user.name}</td>`);
    })
  );
  it.effect(
    "shows only the calls of patches the admin can open, and calls from no patch, as the last call too",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-hidden-calls");
        const { connection, path } = yield* connect(owner.user, "warehouse");
        const { connection: closed } = yield* connect(owner.user, "ledger");
        const audit = yield* RuntimeLog.RuntimeLog;
        // Each call a second after the last, so each call's time names it on the index.
        const call = Effect.fn(function* (
          correlationId: string,
          patchId: string | null,
          connectionId: string = connection.id
        ) {
          yield* TestClock.adjust("1 second");
          yield* audit.begin({
            companyId: owner.company.id,
            patchId,
            versionId: patchId === null ? null : `${patchId}-version`,
            userId: owner.user.id,
            credentialKind: patchId === null ? "admin" : "session",
            op: "postgres.query",
            resource: null,
            connectionId,
            correlationId,
            sql: `SELECT '${correlationId}-sql'`,
            deadlineMs: 15_000
          });
          return `datetime="${new Date(yield* Clock.currentTimeMillis).toISOString()}"`;
        });
        yield* call("admin-call", null);
        const lastShown = yield* call("open-call", "open-patch");
        const newerHidden = yield* call("finance-call", "finance-patch");
        const onlyHidden = yield* call("closed-call", "finance-patch", closed.id);
        const opening = PatchVisibility.PatchVisibility.of({
          openableIds: () => Effect.succeed(["open-patch"])
        });
        const read = (url: string) =>
          send(url, { headers: { cookie: cookie(owner.user) } }).pipe(
            Effect.flatMap((response) => Effect.promise(() => response.text())),
            Effect.provideService(PatchVisibility.PatchVisibility, opening)
          );
        const html = yield* read(`${path}/calls`);
        for (const shown of ["open-call", "open-call-sql", "admin-call", "admin-call-sql"])
          assert.include(html, shown);
        for (const hidden of ["finance-call", "finance-patch"]) assert.notInclude(html, hidden);
        const index = yield* read("/settings/integrations");
        assert.include(index, lastShown);
        for (const hidden of [newerHidden, onlyHidden]) assert.notInclude(index, hidden);
      })
  );
  it.effect("keeps a connection's page and actions when the company directory cannot be read", () =>
    Effect.gen(function* () {
      const owner = yield* createCompany("connections-directory");
      const { path } = yield* connect(owner.user, "warehouse");
      const users = yield* Users.Users;
      const down = {
        ...users,
        list: () =>
          Effect.fail(
            new SqlError({ reason: new ConnectionError({ cause: new Error("directory down") }) })
          )
      };
      const response = yield* send(path, { headers: { cookie: cookie(owner.user) } }).pipe(
        Effect.provideService(Users.Users, down)
      );
      assert.strictEqual(response.status, 200);
      const html = yield* Effect.promise(() => response.text());
      assert.include(html, "<dt>Added by</dt><dd>Unknown</dd>");
      assert.include(html, `href="${path}/disconnect"`);
      const calls = yield* send(`${path}/calls`, { headers: { cookie: cookie(owner.user) } }).pipe(
        Effect.provideService(Users.Users, down)
      );
      assert.strictEqual(calls.status, 200);
      assert.include(yield* Effect.promise(() => calls.text()), 'aria-label="Calls"');
    })
  );
  it.effect(
    "hides connections and snapshots of an integration this release does not ship, as after a rollback",
    () =>
      Effect.gen(function* () {
        const owner = yield* createCompany("connections-unknown");
        const { connection, path } = yield* connect(owner.user, "warehouse");
        const reports = yield* connect(owner.user, "reports");
        // A later release's rows, written straight to the tables. The integration is synthetic so
        // this keeps testing the unknown case as Patchy ships more integrations.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO connections (id, company_id, integration, handle, description, mode,
          status, display, credentials, key_id, credential_revision, metadata_revision, created_by)
          VALUES ('conn_later', ${owner.company.id}, 'future_integration', 'product',
            'From a later release', 'company', 'connected', '{"region":"us"}'::jsonb, 'later',
            'later', 1, 1, ${owner.user.id})`;
        yield* sql`INSERT INTO connection_snapshots (connection_id, company_id, integration,
          revision, snapshot)
          VALUES ('conn_later', ${owner.company.id}, 'future_integration', 1, '{"events":[]}'::jsonb)`;
        const store = yield* ConnectionStore.ConnectionStore;
        const company = owner.company.id;
        assert.deepStrictEqual(
          (yield* store.list(company)).map((item) => item.id).sort(),
          [connection.id, reports.connection.id].sort()
        );
        const declaration = {
          kind: "postgres" as const,
          handle: "product",
          id: "conn_later",
          revision: 1
        };
        // Reads and actions on it are typed refusals, never decode failures.
        const refusals = yield* Effect.all([
          Effect.flip(store.get(company, "conn_later")),
          Effect.flip(store.snapshot(company, "conn_later", 1)),
          Effect.flip(
            store.describe({
              companyId: company,
              userId: owner.user.id,
              id: "conn_later",
              description: ""
            })
          ),
          Effect.flip(store.resolve(company, declaration)),
          Effect.flip(store.poolCredentials(company, declaration, 1))
        ]);
        assert.deepStrictEqual(
          refusals.map((error) => error._tag),
          [
            "ConnectionNotFound",
            "ConnectionNotFound",
            "ConnectionNotFound",
            "ConnectionNotConnected",
            "ConnectionNotConnected"
          ]
        );
        const index = yield* send("/settings/integrations", {
          headers: { cookie: cookie(owner.user) }
        });
        assert.strictEqual(index.status, 200);
        const html = yield* Effect.promise(() => index.text());
        assert.include(html, `href="${path}"`);
        assert.notInclude(html, "conn_later");
        assert.notInclude(html, "From a later release");
        const unknown = "/settings/integrations/conn_later";
        assert.strictEqual(
          (yield* send(unknown, { headers: { cookie: cookie(owner.user) } })).status,
          404
        );
        assert.strictEqual((yield* send(`${unknown}/disconnect`, post(owner.user))).status, 404);
        // A known connection whose current snapshot names another integration keeps the
        // connection and reads its metadata as unavailable.
        yield* sql`INSERT INTO connection_snapshots (connection_id, company_id, integration,
          revision, snapshot)
          VALUES (${reports.connection.id}, ${company}, 'future_integration', 2, '{"events":[]}'::jsonb)`;
        yield* sql`UPDATE connections SET metadata_revision = 2 WHERE id = ${reports.connection.id}`;
        const detail = yield* store.detail(company, "postgres", "reports");
        assert.strictEqual(detail.handle, "reports");
        assert.isNull(detail.snapshot);
        assert.strictEqual(
          (yield* Effect.flip(store.snapshot(company, reports.connection.id, 2)))._tag,
          "ConnectionNotFound"
        );
      })
  );
  it.effect(
    "connects PostHog through the shared frame, refusing each field where it's wrong, and replaces the key in place",
    () =>
      Effect.gen(function* () {
        events.length = 0;
        const owner = yield* createCompany("connections-posthog");
        const path = "/settings/integrations/connect/posthog";
        const read = Effect.fn(function* (target: string) {
          const response = yield* send(target, { headers: { cookie: cookie(owner.user) } });
          return { status: response.status, html: yield* Effect.promise(() => response.text()) };
        });
        const form = yield* read(path);
        assert.strictEqual(form.status, 200);
        // The shared frame: numbered sections, nothing marked done, then what it can and can't do.
        assert.include(form.html, '<span class="flow-number">1</span>Make a personal API key');
        assert.include(form.html, "<td>Event definitions</td><td>Read</td>");
        assert.notInclude(form.html.slice(form.html.indexOf("<body>")), "step-done");
        assert.include(form.html, "Builders' agents read it while they build");
        assert.include(form.html, "Nothing is written to PostHog");
        assert.include(
          form.html,
          '<label class="field-prefix" for="connection-handle">posthog/</label>'
        );
        assert.include(form.html, '<option value="eu">EU Cloud · eu.posthog.com</option>');
        const fields = {
          handle: "warehouse",
          description: "Product analytics",
          region: "eu",
          project: String(posthogProject.id),
          key: posthogProject.key
        };
        const refused = Effect.fn(function* (
          changes: Record<string, string>,
          field: string,
          code: string
        ) {
          const response = yield* send(path, post(owner.user, { ...fields, ...changes }));
          assert.strictEqual(response.status, 422);
          const html = yield* Effect.promise(() => response.text());
          assert.include(html, code);
          assert.include(html, `id="connection-${field}-error"`);
          assert.match(html, new RegExp(`id="connection-${field}"[^>]*aria-invalid="true"`));
          // The key is never echoed back; region and project are kept.
          assert.notInclude(html, posthogProject.key);
          assert.notInclude(html, "phx_wrongKey000000");
          assert.include(html, `value="${changes.project ?? fields.project}"`);
        });
        yield* refused({ project: "abc" }, "project", "invalid_credentials");
        yield* refused({ key: "phc_projectToken00001" }, "key", "project API key");
        yield* refused({ key: "phx_wrongKey000000" }, "key", "posthog_key_rejected");
        assert.deepStrictEqual(
          yield* (yield* ConnectionStore.ConnectionStore).list(owner.company.id),
          []
        );

        // A Postgres connection already named warehouse leaves the name free for PostHog.
        yield* connect(owner.user, "warehouse");
        const created = yield* send(path, post(owner.user, fields));
        assert.strictEqual(created.status, 303);
        const page = yield* follow(created, owner.user);
        assert.include(page, "PostHog connected and its events discovered.");
        const connection = (yield* (yield* ConnectionStore.ConnectionStore).list(
          owner.company.id
        )).find((item) => item.integration === "posthog")!;
        assert.deepStrictEqual(connection.display, {
          region: "eu",
          projectId: posthogProject.id,
          keyHint: "phx_…ey01"
        });
        assert.include(page, '<h1 class="title">posthog/warehouse</h1>');
        assert.include(
          page,
          "<dt>Project</dt><dd>4321, EU Cloud</dd><dt>Key</dt><dd>phx_…ey01</dd>"
        );
        assert.include(page, "2 events, 1 event property and 1 person property.");
        assert.include(page, '<span class="row-name">$pageview</span>');
        assert.include(page, "patchy add posthog/warehouse");
        for (const label of ["Refresh events", "Replace key…", "Change project…"])
          assert.include(page, label);
        assert.deepInclude(reported(owner.company.id), [
          "connection.connected",
          owner.user.id,
          connection.id,
          "posthog"
        ]);

        // A query's name labels its call; its text is kept, its values are not.
        const audit = yield* RuntimeLog.RuntimeLog;
        yield* storePatch(owner, "posthog-patch", "visits");
        yield* audit.begin({
          companyId: owner.company.id,
          patchId: "posthog-patch",
          versionId: "posthog-version",
          userId: owner.user.id,
          credentialKind: "session",
          op: "posthog.query",
          resource: "public.dailyVisits",
          connectionId: connection.id,
          correlationId: "cor_posthog_page",
          sql: "SELECT count() FROM events WHERE event = {event}",
          deadlineMs: 15_000
        });
        const withCalls = (yield* read(`/settings/integrations/${connection.id}/calls`)).html;
        assert.include(withCalls, "<code>query public.dailyVisits</code>");
        assert.include(withCalls, "SELECT count() FROM events WHERE event = {event}");

        const replace = yield* read(`/settings/integrations/${connection.id}/rotate`);
        assert.include(replace.html, 'id="connection-key"');
        assert.notInclude(replace.html, 'id="connection-project"');
        // A refusal about a field this form doesn't show reads above its actions, in focus.
        const gone = yield* send(
          `/settings/integrations/${connection.id}/rotate`,
          post(owner.user, { key: "phx_projectGoneKey0001" })
        );
        assert.strictEqual(gone.status, 422);
        const goneHtml = yield* Effect.promise(() => gone.text());
        assert.include(goneHtml, "posthog_project_not_found");
        assert.include(goneHtml, '<div tabindex="-1" autofocus>');
        assert.notInclude(goneHtml, "phx_projectGoneKey0001");
        // Change project starts in the project's region, with Project ID to type.
        const change = yield* read(`/settings/integrations/${connection.id}/retarget`);
        assert.include(change.html, '<option value="eu" selected>');
        assert.match(change.html, /id="connection-project"[^>]*autofocus/);
        yield* follow(
          yield* send(
            `/settings/integrations/${connection.id}/rotate`,
            post(owner.user, { key: "phx_connectionPagesKey02" })
          ),
          owner.user
        );
        const rotated = yield* (yield* ConnectionStore.ConnectionStore).get(
          owner.company.id,
          connection.id
        );
        assert.deepInclude(rotated, {
          credentialRevision: connection.credentialRevision + 1,
          metadataRevision: connection.metadataRevision,
          display: { region: "eu", projectId: posthogProject.id, keyHint: "phx_…ey02" }
        });
      })
  );
});
