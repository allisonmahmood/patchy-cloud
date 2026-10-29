// @effect-diagnostics nodeBuiltinImport:off -- A stub answers on a real socket, as a proxy would.
import { createServer } from "node:http";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CURRENT_RELEASE,
  DevReadsGroup,
  type Manifest,
  type PidgeonSnapshot,
  PostgresRows,
  RuntimeFailure,
  WIRE_VERSION,
  PostHogDeclaration
} from "@patchy/api";
import { Authorization, MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Directory } from "@patchy/companies";
import { ContractLimits, Limits } from "@patchy/limits";
import { Binding, LoadedVersions, Runtime, RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import * as ConnectionStore from "./ConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as DevDoor from "./DevDoor.js";
import * as DevReads from "./DevReads.js";
import * as AttioDev from "./attio/Dev.js";
import * as PidgeonDev from "./pidgeon/Dev.js";
import * as PidgeonOperations from "./pidgeon/Operations.js";
import * as PostgresSource from "./postgres/Source.js";
import * as PostHogDev from "./posthog/Dev.js";
import * as PostHogOperations from "./posthog/Operations.js";
import * as SqlConnectionStore from "./SqlConnectionStore.js";
import * as AttioReads from "./test/attioReads.js";
import * as PidgeonTest from "./test/pidgeon.js";
import * as PostHogDouble from "./test/posthog.js";
import { decodeError, isPatchyError } from "../../patchy/src/clientError.js";

/**
 * `patchy dev`'s live bindings against a real instance door: the endpoint on a socket over a
 * migrated database, its PostHog the double and its Pidgeon answers recorded from Pidgeon.
 * Nothing reaches the network. What Pidgeon itself decides is the live tier's.
 */

type Declaration = typeof PostHogDeclaration.Type;
type Viewer = Exclude<NonNullable<Binding.Binding["Service"]["identity"]>, { kind: "guest" }>;

/** Queries named `hold…` wait here until a test lets them answer. */
let held: PromiseWithResolvers<void> | undefined;
const rows = () =>
  PostHogDouble.rows(
    [
      ["event", "String"],
      ["views", "UInt64"]
    ],
    [
      ["$pageview", 30],
      ["$autocapture", 12]
    ]
  );
const project = {
  region: "us",
  id: 4242,
  key: "phx_devReadsKey000001",
  query: async ({ name, query }) => {
    if (name?.startsWith("hold") && held !== undefined) await held.promise;
    if (query === "SELECT 1") return PostHogDouble.rows([["1", "UInt8"]], [[1]]);
    if (name === "limited")
      return PostHogDouble.json(
        429,
        { type: "throttled", code: "rate_limit_exceeded", detail: "Too many queries." },
        { "retry-after": "7" }
      );
    if (query.includes("numbers(1001)"))
      return PostHogDouble.rows(
        [["n", "UInt64"]],
        Array.from({ length: 1001 }, (_, n) => [n])
      );
    return query.includes("FROM events")
      ? rows()
      : PostHogDouble.json(400, {
          type: "validation_error",
          code: "syntax_error",
          detail: "Unknown table"
        });
  }
} satisfies PostHogDouble.Project;
const double = PostHogDouble.make(PostHogDouble.project(project));
const queries = () => double.requests.filter((request) => request.url.pathname.endsWith("/query/"));

const foreign = { companyId: "cmp_dev_reads_foreign", connectionId: "conn_dev_reads_foreign" };
const member = "usr_dev_reads_member";
const read = {
  name: "dailyViews",
  query: "SELECT event, count() AS views FROM events GROUP BY event LIMIT 10",
  shape: { event: { kind: "text" }, views: { kind: "integer" } }
} as const;

/**
 * The company's Pidgeon addresses, seeded as connect saves them: `support` sends, `invoices`
 * only reads, and `closed` is one an admin disconnects. Each is `<handle>@acme.example`, its
 * Pidgeon id `idn-<connection id>`.
 */
const address = (id: string, handle: string) => ({
  id,
  handle,
  email: `${handle}@acme.example`,
  identityId: `idn-${id}`
});
const support = address("conn_dev_support", "support");
const invoices = address("conn_dev_invoices", "invoices");
const closed = address("conn_dev_closed", "closed");

/** Pidgeon's answers for `support`, as Pidgeon gives them; a held message has no content. */
const threadRow = {
  id: "thr_1",
  identity: support.email,
  subject: "Where is my order?",
  status: "open",
  message_count: 2,
  folder: "inbox",
  from: "sam@customer.example",
  from_name: "Sam",
  preview: "Hi, my order 1043…",
  has_attachments: false,
  last_message_at: "2026-10-26T09:00:00.000Z",
  created_at: "2026-10-25T08:00:00.000Z"
};
const messageRow = (id: string, held: boolean) => ({
  id,
  thread_id: "thr_1",
  identity_id: support.identityId,
  from: { email: "sam@customer.example", name: "Sam" },
  to: [{ email: support.email }],
  cc: [],
  subject: held ? null : "Where is my order?",
  text: held ? null : "Hi, my order 1043 hasn't arrived.",
  html: held ? null : "<p>Hi, my order 1043 hasn't arrived.</p>",
  test: true,
  is_held: held,
  firewall: {
    verdict: held ? "suspicious" : "clean",
    signals: held ? [{ kind: "assistant_directive", detail: "Ignore all previous" }] : []
  },
  attachments: [],
  delivery: null,
  created_at: "2026-10-25T08:00:00.000Z"
});
const page = (data: ReadonlyArray<unknown>) => ({ data, has_more: false, next_cursor: null });
const mail = PidgeonTest.recorded([
  {
    match: (sent) =>
      PidgeonTest.route("GET", "/threads")(sent) && sent.query.identity_id === support.identityId,
    body: page([threadRow])
  },
  { match: PidgeonTest.route("GET", "/threads/thr_1"), body: { data: threadRow } },
  { match: PidgeonTest.route("GET", "/threads/thr_1/labels"), body: page([]) },
  { match: PidgeonTest.route("GET", "/labels"), body: page([]) },
  {
    match: PidgeonTest.route("GET", "/messages"),
    body: page([messageRow("msg_1", false), messageRow("msg_held", true)])
  },
  {
    match: PidgeonTest.route("GET", "/messages/msg_held"),
    status: 403,
    body: { error: { code: "held", message: "This message is held for review." } }
  }
]);
/**
 * The company's Attio workspace as dev reads it: `crm` was refreshed once, so its revision 1
 * snapshot lacks the `forecast` attribute Attio has now, and `other` is another connection with
 * revisions `crm` doesn't have.
 */
const crm = { id: "conn_dev_crm", handle: "crm" };
const otherCrm = { id: "conn_dev_crm_other", handle: "sales" };
const refreshed: typeof AttioReads.snapshot = {
  ...AttioReads.snapshot,
  objects: AttioReads.snapshot.objects.map((object) =>
    object.slug !== "deals"
      ? object
      : {
          ...object,
          attributes: [
            ...object.attributes,
            {
              id: AttioReads.uuid(990),
              slug: "forecast",
              title: "Forecast",
              type: "number",
              multiselect: false
            }
          ]
        }
  )
};
const deal = AttioReads.record("deals", AttioReads.uuid(1001), {
  name: [AttioReads.items.text("Bikes for Lumen")]
});
/** A deal as Attio answers it now, with the attribute the Refresh found. */
const withForecast = {
  ...deal,
  values: { ...deal.values, forecast: [AttioReads.items.number(0.6)] }
};
const workspace = AttioReads.scripted(
  [
    AttioReads.route("POST", "/objects/deals/records/query", {
      body: { data: [withForecast] }
    })
  ],
  refreshed
);

/** What Pidgeon heard: never anything but a read, and never the machine's key. */
const heard = () => mail.requests;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${member}, ${member}, ${DEV_SEED.companyId}, 'member@dev-reads.test', 'Morgan', 'member')`;
  yield* sql`INSERT INTO companies (id, handle, name)
    VALUES (${foreign.companyId}, 'dev-reads-foreign', 'Foreign')`;
  yield* sql`INSERT INTO connections
    (id, company_id, integration, handle, description, mode, status, display, credentials,
      key_id, credential_revision, metadata_revision, created_by)
    VALUES (${foreign.connectionId}, ${foreign.companyId}, 'posthog', 'product', '', 'company',
      'connected', ${JSON.stringify({ region: "us", projectId: 1, keyHint: "phx_…0000" })},
      'never-decrypted', 'missing-key', 1, 1, ${DEV_SEED.userId})`;
  const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
  yield* PidgeonTest.seed({ ...who, id: support.id, handle: support.handle });
  yield* PidgeonTest.seed({ ...who, id: invoices.id, handle: invoices.handle, access: "read" });
  yield* PidgeonTest.seed({ ...who, id: closed.id, handle: closed.handle });
  yield* AttioReads.seed({ ...who, ...crm, revisions: [AttioReads.snapshot, refreshed] });
  yield* AttioReads.seed({
    ...who,
    ...otherCrm,
    revisions: [refreshed, refreshed, refreshed]
  });
});

/** The runtime this door drains with; it serves no published versions here. */
const runtime = Layer.effect(
  Runtime.Runtime,
  Runtime.make(
    {},
    {
      origin: "https://patchy.example",
      identity: () => Effect.fail(new Runtime.AccessDenied({})),
      bootstrapIdentity: Effect.fail(new Runtime.AccessDenied({}))
    }
  )
).pipe(
  Layer.provide(
    Layer.succeed(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.none())
    })
  )
);

const routes = HttpApiBuilder.layer(HttpApi.make("patchy").add(DevReadsGroup)).pipe(
  Layer.provide(DevReads.layer),
  Layer.provide(Authorization.layer)
);
/** The door on a socket over a migrated database; `log` stands in for the runtime log when given. */
const serve = (
  log: Layer.Layer<RuntimeLog.RuntimeLog, never, SqlClient.SqlClient> = RuntimeLog.layer
) =>
  HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(runtime),
    Layer.provideMerge(
      SqlConnectionStore.layer.pipe(
        Layer.provide(PostgresSource.layer),
        Layer.provideMerge(double.layer),
        Layer.provideMerge(mail.layer),
        Layer.provideMerge(workspace.layer)
      )
    ),
    Layer.provideMerge(Layer.mergeAll(MachineTokens.layer, log, Limits.layer)),
    Layer.provideMerge(Layer.effectDiscard(seed)),
    Layer.provideMerge(
      CredentialKeys.layerFromKeys(
        Redacted.make(`dev-reads:${Buffer.alloc(32, 3).toString("base64")}`)
      )
    ),
    Layer.provideMerge(Testing.layer())
  );
const layer = serve();

/** The company's PostHog connection, connected through the double once per suite. */
const connection = Effect.gen(function* () {
  const store = yield* ConnectionStore.ConnectionStore;
  const found = (yield* store.list(DEV_SEED.companyId)).find(
    (item) => item.integration === "posthog" && item.handle === "product"
  );
  if (found !== undefined) return found;
  return yield* store.connect({
    integration: "posthog",
    companyId: DEV_SEED.companyId,
    userId: DEV_SEED.userId,
    handle: "product",
    description: "Product analytics",
    credentials: PostHogDouble.credentials(project)
  });
}).pipe(Effect.orDie);

const owner: Viewer = {
  user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
  company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: DEV_SEED.companyName },
  admin: true
};
const colleague: Viewer = {
  ...owner,
  user: { id: "usr_dev_colleague", email: "colleague@patchy.local", name: "Dev Colleague" },
  admin: false
};

/** A local dev binding declaring `uses`, as `patchy dev` admits either viewer. */
const local = (uses: (typeof Manifest.Type)["uses"], now: number, viewer: Viewer = owner) =>
  Binding.Binding.of({
    patchId: "localdev0000",
    versionId: "ver_000000000000000000000000",
    companyId: DEV_SEED.companyId,
    scope: "company",
    wireVersion: WIRE_VERSION,
    manifest: {
      manifestVersion: 1,
      release: CURRENT_RELEASE,
      tier: 1,
      tables: {},
      files: {},
      uses
    },
    identity: viewer,
    principal: { userId: viewer.user.id },
    correlationId: "local-dev-call",
    deadline: now + 15_000
  });

const origin = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  if (server.address._tag === "UnixPathAddress") return assert.fail("Expected a TCP listener");
  return `http://127.0.0.1:${server.address.port}`;
});

/** One query through the local binding, with `token`, as the given viewer. */
const query = Effect.fn("test.devReads.query")(function* (
  token: string,
  options: {
    readonly viewer?: Viewer;
    readonly declaration?: Partial<Declaration>;
    readonly args?: Record<string, unknown>;
    readonly apiUrl?: string;
  } = {}
) {
  const found = yield* connection;
  const handlers = yield* PostHogDev.handlers({
    apiUrl: options.apiUrl ?? (yield* origin),
    token: Option.some(Redacted.make(token))
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const declaration: Declaration = {
    kind: "posthog",
    id: found.id,
    handle: found.handle,
    revision: found.metadataRevision,
    ...options.declaration
  };
  return yield* handlers["posthog.query"]
    .run({ connection: "analytics", ...read, ...options.args })
    .pipe(
      Effect.provideService(
        Binding.Binding,
        local({ analytics: declaration }, yield* Clock.currentTimeMillis, options.viewer)
      )
    );
});

/** What generation knows of a Pidgeon address: its access and labels. Every one is reply-only. */
const snapshot = (email: string, access: "read" | "send"): PidgeonSnapshot => ({
  version: 1,
  address: { email, displayName: null, sendPolicy: "reply_only" },
  access,
  test: false,
  labels: [{ id: "lbl-1", name: "Billing", colour: "amber" }],
  plan: "free"
});
const declared = (connection: { readonly id: string; readonly handle: string }) => ({
  kind: "pidgeon" as const,
  id: connection.id,
  handle: connection.handle,
  revision: 1
});
/** The desk repo's declarations: `support`, `invoices` and `closed`, by their handles. */
const desks = {
  support: declared(support),
  invoices: declared(invoices),
  closed: declared(closed)
};
type Desk = keyof typeof desks;
/** The same desk as a published version, for calls a published page makes beside dev's. */
const publishedDesk = (now: number) => ({
  ...local(desks, now),
  patchId: "publishedone",
  versionId: "ver_publishedpublishedpubl"
});

/**
 * A support desk in `patchy dev` with `token`: Pidgeon's dev binding over the desk's addresses,
 * the writes it simulated, and one call through it as the given viewer.
 */
const desk = Effect.fn("test.devReads.desk")(function* (token: string) {
  const simulated: PidgeonDev.Simulated[] = [];
  const handlers = yield* PidgeonDev.handlers(
    { apiUrl: yield* origin, token: Option.some(Redacted.make(token)) },
    {
      support: { declaration: desks.support, snapshot: snapshot(support.email, "send") },
      invoices: { declaration: desks.invoices, snapshot: snapshot(invoices.email, "read") },
      closed: { declaration: desks.closed, snapshot: snapshot(closed.email, "send") }
    },
    (write) => Effect.sync(() => void simulated.push(write))
  ).pipe(Effect.provide(FetchHttpClient.layer));
  const call = (
    op: "pidgeon.read" | "pidgeon.write",
    connection: Desk,
    operation: string,
    input: unknown,
    viewer: Viewer = owner
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      handlers[op]
        .run({ connection, operation, input })
        .pipe(Effect.provideService(Binding.Binding, local(desks, now, viewer)))
    );
  return { call, simulated };
});
/** One email from the desk, as a page sends it. */
const email = (idempotencyKey: string) => ({
  to: ["stranger@elsewhere.example"],
  cc: ["ops@acme.example"],
  subject: "Your order",
  text: "It shipped today.",
  idempotencyKey
});

/** One request straight to the door, as no binding would send it. */
const door = Effect.fn("test.devReads.door")(function* (
  body: unknown,
  authorization = `Bearer ${DEV_SEED.token}`
) {
  const url = `${yield* origin}/api/connections/dev-read`;
  return yield* Effect.promise(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: (await response.json()) as unknown };
  });
});
const refusal = Schema.decodeUnknownSync(RuntimeFailure);

const decodeRows = Schema.decodeUnknownEffect(PostgresRows);
const mint = (userId: string, name: string) =>
  Effect.flatMap(MachineTokens.MachineTokens, (tokens) => tokens.mint({ userId, name }));

/** The newest logged calls through the dev door, as the store keeps them. */
const devCalls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    credentialKind: string;
    machineId: string;
    machineName: string;
    userId: string;
    patchId: string | null;
    versionId: string | null;
    op: string;
    resource: string | null;
    connectionId: string | null;
    outcome: string;
    outcomeCode: string | null;
    rowCount: number | null;
    correlationId: string;
  }>`SELECT credential_kind AS "credentialKind", machine_id AS "machineId",
      machine_name AS "machineName", user_id AS "userId", patch_id AS "patchId",
      version_id AS "versionId", op, resource, connection_id AS "connectionId", outcome,
      outcome_code AS "outcomeCode", row_count AS "rowCount", correlation_id AS "correlationId"
    FROM runtime_calls WHERE credential_kind = 'machine' ORDER BY at DESC, id DESC`;
});

// Live services: the endpoint's clock and the database's are the same real one.
it.layer(layer, { excludeTestServices: true, timeout: "60 seconds" })(
  "PostHog reads in patchy dev",
  (it) => {
    it.effect(
      "both dev viewers read real rows as the machine's person, logged as a dev call",
      () =>
        Effect.gen(function* () {
          const found = yield* connection;
          const before = queries().length;
          for (const viewer of [owner, colleague])
            assert.deepStrictEqual(yield* decodeRows(yield* query(DEV_SEED.token, { viewer })), {
              ok: true,
              rows: [
                { event: "$pageview", views: 30 },
                { event: "$autocapture", views: 12 }
              ]
            });
          // PostHog heard the connection's key, never the machine token.
          const sent = queries().slice(before);
          assert.strictEqual(sent.length, 2);
          for (const request of sent) {
            assert.strictEqual(request.authorization, `Bearer ${project.key}`);
            assert.deepStrictEqual(request.body, {
              query: { kind: "HogQLQuery", query: read.query, name: read.name }
            });
          }
          const [latest] = yield* devCalls;
          assert.deepInclude(latest, {
            credentialKind: "machine",
            machineId: DEV_SEED.tokenId,
            machineName: DEV_SEED.tokenName,
            userId: DEV_SEED.userId,
            patchId: null,
            versionId: null,
            op: "posthog.query",
            resource: "dailyViews",
            connectionId: found.id,
            outcome: "success",
            rowCount: 2
          });
          const log = yield* RuntimeLog.RuntimeLog;
          const [shown] = yield* log.recent({
            companyId: DEV_SEED.companyId,
            connectionId: found.id
          });
          assert.deepStrictEqual(shown?.machine, {
            id: DEV_SEED.tokenId,
            name: DEV_SEED.tokenName
          });
        }),
      30_000
    );

    it.effect(
      "relays the instance's refusals as they were sent, with the logged row",
      () =>
        Effect.gen(function* () {
          const invalid = yield* query(DEV_SEED.token, {
            args: { name: "broken", query: "SELECT * FROM evnts" }
          }).pipe(Effect.flip);
          assert.strictEqual(invalid.code, "invalid_query");
          assert.include(invalid.message, "PostHog rejected the query");
          assert.deepStrictEqual(Runtime.toFailure(invalid).details, { message: "Unknown table" });
          const [row] = yield* devCalls;
          assert.deepInclude(row, { outcome: "failure", outcomeCode: "invalid_query" });
          assert.strictEqual(Runtime.toFailure(invalid).correlationId, row!.correlationId);

          const large = yield* query(DEV_SEED.token, {
            args: {
              name: "tooMany",
              query: "SELECT number AS n FROM numbers(1001)",
              shape: { n: { kind: "integer" } }
            }
          }).pipe(Effect.flip);
          assert.strictEqual(large.code, "too_large");

          // Each refusal names its operation, as a published patch's does, so a patch narrows
          // PostHog's details the same way in dev; a rate limit keeps PostHog's Retry-After.
          const limited = yield* query(DEV_SEED.token, { args: { name: "limited" } }).pipe(
            Effect.flip
          );
          const failure = Runtime.toFailure(limited);
          assert.deepInclude(failure, {
            code: "source_rate_limited",
            retryAfter: 7,
            operation: "posthog.query"
          });
          assert.strictEqual(Runtime.toFailure(invalid).operation, "posthog.query");
          const seen = decodeError(failure);
          assert.isTrue(isPatchyError(seen, "source_rate_limited", "posthog"));
          assert.isFalse(isPatchyError(seen, "source_rate_limited", "postgres"));
          assert.strictEqual(seen?.retryAfter, 7);
          const detailed = decodeError(Runtime.toFailure(invalid));
          if (!isPatchyError(detailed, "invalid_query", "posthog"))
            return assert.fail("invalid_query from PostHog");
          assert.strictEqual(detailed.details.message, "Unknown table");
        }),
      30_000
    );

    it.effect(
      "stops reads for an expired, revoked or idle key and a deactivated person",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tokens = yield* MachineTokens.MachineTokens;
          const cases = [
            [
              "expired",
              (id: string) =>
                sql`UPDATE machine_tokens SET expires_at = now() - interval '1 minute' WHERE id = ${id}`
            ],
            ["revoked", (id: string) => Effect.asVoid(tokens.revoke(id))],
            [
              "idle",
              (id: string) =>
                sql`UPDATE machine_tokens SET last_used_at = now() - interval '31 days' WHERE id = ${id}`
            ],
            ["deactivated", () => sql`UPDATE users SET deactivated_at = now() WHERE id = ${member}`]
          ] as const;
          for (const [label, stop] of cases) {
            const minted = yield* mint(member, `Laptop ${label}`);
            assert.strictEqual(
              (yield* decodeRows(yield* query(minted.token))).rows.length,
              2,
              `${label}: reads before`
            );
            yield* stop(minted.id);
            const refused = yield* query(minted.token).pipe(Effect.flip);
            assert.instanceOf(refused, DevDoor.KeyRefused, label);
            assert.strictEqual(refused.code, "access_denied");
            assert.include(refused.message, "Run `patchy login`");
          }
          yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = ${member}`;
        }),
      30_000
    );

    it.effect(
      "refuses a disconnected source and another company's connection",
      () =>
        Effect.gen(function* () {
          const store = yield* ConnectionStore.ConnectionStore;
          const found = yield* connection;
          const other = yield* query(DEV_SEED.token, {
            declaration: { id: foreign.connectionId }
          }).pipe(Effect.flip);
          assert.strictEqual(other.code, "access_denied");
          assert.include(other.message, "Your company has no connection posthog/product");
          // Another company's id is neither recorded nor confirmed.
          assert.strictEqual((yield* devCalls)[0]!.connectionId, null);

          const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId, id: found.id };
          yield* store.disconnect(who);
          const disconnected = yield* query(DEV_SEED.token).pipe(Effect.flip);
          assert.include(disconnected.message, "posthog/product is disconnected");
          assert.deepInclude((yield* devCalls)[0], {
            connectionId: found.id,
            outcomeCode: "access_denied"
          });
          yield* store.reconnect(who);
          assert.strictEqual((yield* decodeRows(yield* query(DEV_SEED.token))).rows.length, 2);
        }),
      30_000
    );

    it.effect(
      "runs only what a definition lets dev read live, and logs what it refuses",
      () =>
        Effect.gen(function* () {
          const found = yield* connection;
          const url = `${yield* origin}/api/connections/dev-read`;
          const post = door;
          const connection_ = { id: found.id, handle: found.handle };
          const postgres = yield* post({
            op: "postgres.query",
            connection: connection_,
            args: { sql: "select 1", shape: {} }
          });
          assert.strictEqual(postgres.status, 400);
          assert.strictEqual(refusal(postgres.body).code, "invalid_request");
          assert.deepInclude((yield* devCalls)[0], {
            op: "postgres.query",
            outcomeCode: "invalid_request"
          });

          const extra = yield* post({
            op: "posthog.query",
            connection: connection_,
            args: { ...read, connection: "analytics" }
          });
          assert.strictEqual(extra.status, 400);
          assert.strictEqual(
            refusal(extra.body).correlationId,
            (yield* devCalls)[0]!.correlationId
          );

          // Postgres text can't hold NUL, so the log keeps a stand-in and the call is still refused.
          for (const [args, resource] of [
            [{ ...read, name: "nul\u0000name" }, "nul\uFFFDname"],
            [{ ...read, query: "SELECT\u0000 1" }, read.name]
          ] as const) {
            const nul = yield* post({ op: "posthog.query", connection: connection_, args });
            assert.strictEqual(nul.status, 400);
            assert.strictEqual(refusal(nul.body).code, "invalid_request");
            assert.deepInclude((yield* devCalls)[0], {
              correlationId: refusal(nul.body).correlationId,
              outcomeCode: "invalid_request",
              resource
            });
          }

          const before = (yield* devCalls).length;
          // A body that never declares its length is cut off as it streams, at the largest live
          // operation's bound, Pidgeon's; then each operation's own bound holds, unlogged.
          const streamed = yield* Effect.promise(async () => {
            const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
            const response = await fetch(url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${DEV_SEED.token}`,
                "content-type": "application/json"
              },
              duplex: "half",
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  for (let sent = 0; sent < 17; sent++) controller.enqueue(chunk);
                  controller.close();
                }
              })
            } as RequestInit & { duplex: "half" });
            return { status: response.status, body: (await response.json()) as unknown };
          });
          assert.strictEqual(streamed.status, 413);
          assert.deepInclude(refusal(streamed.body), {
            code: "too_large",
            limitId: "runtime.pidgeon.bytes"
          });
          const oversized = yield* post({
            op: "posthog.query",
            connection: connection_,
            args: { ...read, query: `SELECT 1 -- ${"x".repeat(300_000)}` }
          });
          assert.strictEqual(oversized.status, 413);
          assert.deepInclude(refusal(oversized.body), {
            code: "too_large",
            limitId: "runtime.posthog.bytes"
          });
          assert.strictEqual((yield* devCalls).length, before);

          const anonymous = yield* post({}, "Bearer not-a-token");
          assert.strictEqual(anonymous.status, 401);
        }),
      30_000
    );

    it.effect(
      "shares each project's slots with published reads, and checks the key again after waiting",
      () =>
        Effect.gen(function* () {
          const found = yield* connection;
          const minted = yield* mint(DEV_SEED.userId, "Shared slots");
          // A published patch fills the project's three slots through the same Source.
          const published = yield* PostHogOperations.makeHandlers;
          const declaration = {
            kind: "posthog" as const,
            id: found.id,
            handle: found.handle,
            revision: found.metadataRevision
          };
          held = Promise.withResolvers<void>();
          const now = yield* Clock.currentTimeMillis;
          const before = queries().length;
          const holding = yield* Effect.forEach([1, 2, 3], (n) =>
            published["posthog.query"]
              .run({ connection: "analytics", ...read, name: `hold${n}` })
              .pipe(
                Effect.provideService(Binding.Binding, {
                  ...local({ analytics: declaration }, now),
                  patchId: "publishedone",
                  versionId: "ver_publishedpublishedpubl"
                }),
                Effect.forkChild
              )
          );
          while (queries().length < before + 3) yield* Effect.sleep("10 millis");
          const waiting = yield* query(minted.token, { args: { name: "waiting" } }).pipe(
            Effect.flip,
            Effect.forkChild
          );
          const sql = yield* SqlClient.SqlClient;
          while (
            (yield* sql`SELECT 1 FROM runtime_calls WHERE resource = 'waiting' AND outcome = 'pending'`)
              .length === 0
          )
            yield* Effect.sleep("10 millis");
          yield* (yield* MachineTokens.MachineTokens).revoke(minted.id);
          held.resolve();
          for (const fiber of holding) yield* Fiber.join(fiber);
          const refused = yield* Fiber.join(waiting);
          assert.instanceOf(refused, DevDoor.KeyRefused);
          assert.isString(Runtime.toFailure(refused).correlationId);
          // The waiting read never reached PostHog.
          assert.deepStrictEqual(
            queries()
              .slice(before)
              .map((request) => (request.body as { query: { name: string } }).query.name)
              .sort(),
            ["hold1", "hold2", "hold3"]
          );
          held = undefined;
        }),
      30_000
    );

    it.effect(
      "a caller that stops waiting sends nothing, and a draining host takes no new reads",
      () =>
        Effect.gen(function* () {
          const found = yield* connection;
          const published = yield* PostHogOperations.makeHandlers;
          const declaration = {
            kind: "posthog" as const,
            id: found.id,
            handle: found.handle,
            revision: found.metadataRevision
          };
          held = Promise.withResolvers<void>();
          const now = yield* Clock.currentTimeMillis;
          const before = queries().length;
          const holding = yield* Effect.forEach([1, 2, 3], (n) =>
            published["posthog.query"]
              .run({ connection: "analytics", ...read, name: `hold${n}` })
              .pipe(
                Effect.provideService(Binding.Binding, local({ analytics: declaration }, now)),
                Effect.forkChild
              )
          );
          while (queries().length < before + 3) yield* Effect.sleep("10 millis");
          // An action with half a second left gives up while queued; the instance drops it too.
          const gaveUp = yield* query(DEV_SEED.token, { args: { name: "gaveUp" } }).pipe(
            Effect.timeoutOption("500 millis")
          );
          assert.isTrue(Option.isNone(gaveUp));
          held.resolve();
          for (const fiber of holding) yield* Fiber.join(fiber);
          yield* Effect.sleep("200 millis");
          assert.strictEqual(queries().length, before + 3);
          held = undefined;

          const unreachable = yield* query(DEV_SEED.token, { apiUrl: "http://127.0.0.1:1" }).pipe(
            Effect.flip
          );
          assert.instanceOf(unreachable, DevDoor.InstanceUnavailable);
          assert.strictEqual(unreachable.code, "source_unavailable");
          assert.include(unreachable.message, "Other dev work keeps going");

          yield* (yield* Runtime.Runtime).drain;
          const draining = yield* query(DEV_SEED.token).pipe(Effect.flip);
          assert.strictEqual(draining.code, "busy");
        }),
      30_000
    );
  }
);

it.layer(layer, { excludeTestServices: true, timeout: "60 seconds" })(
  "Attio in patchy dev",
  (it) => {
    it.effect(
      "reads by the snapshot the repo was generated from, and refuses another connection's revision",
      () =>
        Effect.gen(function* () {
          const handlers = yield* AttioDev.handlers({
            apiUrl: yield* origin,
            token: Option.some(Redacted.make(DEV_SEED.token))
          }).pipe(Effect.provide(FetchHttpClient.layer));
          const list = (revision: number) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              handlers["attio.listRecords"]
                .run({ connection: "crm", object: "deals" })
                .pipe(
                  Effect.provideService(
                    Binding.Binding,
                    local({ crm: { kind: "attio", ...crm, revision } }, now)
                  )
                )
            );
          type Rows = { readonly rows: ReadonlyArray<{ readonly values: object }> };
          // A client generated before the Refresh decodes as generated: without `forecast`.
          const before = (yield* list(1)) as Rows;
          assert.notProperty(before.rows[0]!.values, "forecast");
          assert.propertyVal(before.rows[0]!.values, "name", "Bikes for Lumen");
          const after = (yield* list(2)) as Rows;
          assert.propertyVal(after.rows[0]!.values, "forecast", 0.6);
          assert.deepInclude((yield* devCalls)[0], {
            credentialKind: "machine",
            userId: DEV_SEED.userId,
            patchId: null,
            op: "attio.listRecords",
            resource: "deals",
            connectionId: crm.id,
            outcome: "success",
            rowCount: 1
          });
          // A revision only another connection has is no snapshot of this one.
          const foreign = Runtime.toFailure(yield* list(3).pipe(Effect.flip));
          assert.include(foreign, { code: "access_denied" });
          assert.include(foreign.error, "attio/crm");
          // Straight to the door without a revision, an Attio read is refused, logged and unsent.
          const sent = workspace.requests.length;
          const bare = yield* door({
            op: "attio.listRecords",
            connection: crm,
            args: { object: "deals" }
          });
          assert.strictEqual(bare.status, 400);
          assert.include(refusal(bare.body), { code: "invalid_request" });
          assert.strictEqual(workspace.requests.length, sent);
        }),
      30_000
    );
  }
);

it.layer(layer, { excludeTestServices: true, timeout: "60 seconds" })(
  "Pidgeon in patchy dev",
  (it) => {
    it.effect(
      "both dev viewers read the real address as the machine's person, held mail empty, logged as a dev call",
      () =>
        Effect.gen(function* () {
          const { call } = yield* desk(DEV_SEED.token);
          const before = heard().length;
          for (const viewer of [owner, colleague]) {
            const listed = yield* call("pidgeon.read", "support", "threads.list", {}, viewer);
            assert.deepStrictEqual(
              (listed as { threads: ReadonlyArray<{ id: string }> }).threads.map(({ id }) => id),
              ["thr_1"]
            );
          }
          const opened = yield* call("pidgeon.read", "support", "threads.get", { id: "thr_1" });
          const [kept, held] = (opened as { messages: ReadonlyArray<object> }).messages;
          assert.deepInclude(kept, { id: "msg_1", text: "Hi, my order 1043 hasn't arrived." });
          assert.deepInclude(held, {
            id: "msg_held",
            held: true,
            subject: null,
            text: "",
            attachments: [],
            firewall: { verdict: "suspicious", kinds: ["assistant_directive"] }
          });
          // Pidgeon heard reads of the address alone, with its own key, never the machine's.
          const sent = heard().slice(before);
          assert.isNotEmpty(sent);
          for (const request of sent) {
            assert.strictEqual(request.method, "GET");
            assert.match(request.authorization ?? "", /^Bearer pgn_live_seeded/);
          }
          assert.strictEqual(
            sent.find(PidgeonTest.route("GET", "/threads"))?.query.identity_id,
            support.identityId
          );
          assert.deepInclude((yield* devCalls)[0], {
            credentialKind: "machine",
            machineId: DEV_SEED.tokenId,
            userId: DEV_SEED.userId,
            patchId: null,
            versionId: null,
            op: "pidgeon.read",
            resource: "threads.get thr_1",
            connectionId: support.id,
            outcome: "success",
            rowCount: 2
          });

          // Held mail stays unreadable, refused as a published read is, naming the operation.
          const refused = yield* call("pidgeon.read", "support", "messages.get", {
            id: "msg_held"
          }).pipe(Effect.flip);
          const failure = Runtime.toFailure(refused);
          assert.deepInclude(failure, {
            code: "access_denied",
            operation: "pidgeon.read",
            details: { reason: "held" }
          });
          assert.isTrue(isPatchyError(decodeError(failure), "access_denied", "pidgeon"));
          assert.deepInclude((yield* devCalls)[0], {
            resource: "messages.get msg_held",
            outcomeCode: "access_denied"
          });
        }),
      30_000
    );

    it.effect(
      "runs no write: one sent straight to the door is refused and logged, and reaches no one",
      () =>
        Effect.gen(function* () {
          const before = heard().length;
          const connection = { id: support.id, handle: support.handle };
          const write = yield* door({
            op: "pidgeon.write",
            connection,
            args: { operation: "messages.send", input: email("door-write-0001") }
          });
          assert.strictEqual(write.status, 400);
          assert.strictEqual(refusal(write.body).code, "invalid_request");
          assert.deepInclude((yield* devCalls)[0], {
            op: "pidgeon.write",
            connectionId: support.id,
            outcomeCode: "invalid_request",
            correlationId: refusal(write.body).correlationId
          });
          // The repo's alias stays in the repo.
          const aliased = yield* door({
            op: "pidgeon.read",
            connection,
            args: { connection: "support", operation: "threads.list", input: {} }
          });
          assert.strictEqual(aliased.status, 400);
          assert.strictEqual(heard().length, before);
        }),
      30_000
    );

    it.effect(
      "simulates sends, replies and triage: nothing reaches the instance or Pidgeon, and each shows its recipients",
      () =>
        Effect.gen(function* () {
          const { call, simulated } = yield* desk(DEV_SEED.token);
          const [calls, requests] = [(yield* devCalls).length, heard().length];
          // The address is reply-only and has never written to this stranger: dev doesn't check
          // the send policy, which only Pidgeon can apply.
          const sent = yield* call(
            "pidgeon.write",
            "support",
            "messages.send",
            email("dev-send-0001")
          );
          assert.deepInclude(sent, { status: "sent", rejected: [], replayed: false, test: true });
          const { messageId, threadId } = sent as { messageId: string; threadId: string };
          assert.match(messageId, /^dev_/);
          assert.match(threadId, /^dev_/);
          assert.deepInclude(
            yield* call("pidgeon.write", "support", "messages.reply", {
              id: "msg_1",
              text: "It's on its way.",
              idempotencyKey: "dev-reply-0001"
            }),
            { status: "sent", test: true }
          );
          assert.deepInclude(
            yield* call("pidgeon.write", "support", "threads.update", {
              id: "thr_1",
              status: "waiting"
            }),
            { id: "thr_1", status: "waiting" }
          );
          assert.deepStrictEqual(
            yield* call("pidgeon.write", "support", "threads.label", {
              id: "thr_1",
              labelId: "lbl-1"
            }),
            { labels: [{ id: "lbl-1", name: "Billing", colour: "amber" }] }
          );
          assert.deepStrictEqual(
            yield* call("pidgeon.write", "support", "threads.unlabel", {
              id: "thr_1",
              labelId: "lbl-1"
            }),
            { labels: [] }
          );
          assert.deepStrictEqual(
            simulated.map(({ summary }) => summary),
            [
              "messages.send “Your order” to stranger@elsewhere.example cc ops@acme.example",
              "messages.reply msg_1",
              "threads.update thr_1 waiting",
              "threads.label thr_1 lbl-1",
              "threads.unlabel thr_1 lbl-1"
            ]
          );
          assert.deepStrictEqual(simulated[0], {
            viewerId: owner.user.id,
            connection: "pidgeon/support",
            operation: "messages.send",
            summary: simulated[0]!.summary
          });
          // Nothing reached the instance's door or Pidgeon.
          assert.strictEqual((yield* devCalls).length, calls);
          assert.strictEqual(heard().length, requests);

          // Arguments are checked as the host checks them.
          for (const input of [
            { ...email("dev-send-0002"), to: [] },
            email("short"),
            { ...email("dev-send-0003"), html: "<p>Hi</p>" }
          ]) {
            const invalid = yield* call("pidgeon.write", "support", "messages.send", input).pipe(
              Effect.flip
            );
            assert.strictEqual(invalid.code, "invalid_request");
          }
          assert.lengthOf(simulated, 5);
        }),
      30_000
    );

    it.effect(
      "refuses a write on a read connection in dev as a published patch's is refused",
      () =>
        Effect.gen(function* () {
          const { call, simulated } = yield* desk(DEV_SEED.token);
          const input = { id: "msg_1", text: "Thanks!", idempotencyKey: "dev-readonly-01" };
          const inDev = yield* call("pidgeon.write", "invoices", "messages.reply", input).pipe(
            Effect.flip
          );
          const handlers = yield* PidgeonOperations.makeHandlers.pipe(
            Effect.provide(Directory.layer)
          );
          const asPublished = yield* handlers["pidgeon.write"]
            .run({ connection: "invoices", operation: "messages.reply", input })
            .pipe(
              Effect.provideService(Binding.Binding, publishedDesk(yield* Clock.currentTimeMillis)),
              Effect.flip
            );
          assert.strictEqual(inDev.code, "access_denied");
          assert.deepStrictEqual(Runtime.toFailure(inDev), Runtime.toFailure(asPublished));
          assert.lengthOf(simulated, 0);
        }),
      30_000
    );

    it.effect(
      "a revoked key, a deactivated person or a disconnected address stops dev reads; simulated writes keep working",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tokens = yield* MachineTokens.MachineTokens;
          const cases = [
            ["revoked", (id: string) => Effect.asVoid(tokens.revoke(id))],
            ["deactivated", () => sql`UPDATE users SET deactivated_at = now() WHERE id = ${member}`]
          ] as const;
          for (const [label, stop] of cases) {
            const minted = yield* mint(member, `Desk ${label}`);
            const { call } = yield* desk(minted.token);
            yield* call("pidgeon.read", "support", "threads.list", {});
            yield* stop(minted.id);
            const refused = yield* call("pidgeon.read", "support", "threads.list", {}).pipe(
              Effect.flip
            );
            assert.instanceOf(refused, DevDoor.KeyRefused, label);
            assert.include(refused.message, "Run `patchy login`");
            assert.deepInclude(
              yield* call("pidgeon.write", "support", "messages.send", email(`dev-${label}-01`)),
              { status: "sent" },
              label
            );
          }
          yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = ${member}`;

          const store = yield* ConnectionStore.ConnectionStore;
          yield* store.disconnect({
            companyId: DEV_SEED.companyId,
            userId: DEV_SEED.userId,
            id: closed.id
          });
          const { call } = yield* desk(DEV_SEED.token);
          const disconnected = yield* call("pidgeon.read", "closed", "threads.list", {}).pipe(
            Effect.flip
          );
          assert.strictEqual(disconnected.code, "access_denied");
          assert.include(disconnected.message, "pidgeon/closed is disconnected");
          assert.deepInclude((yield* devCalls)[0], {
            connectionId: closed.id,
            outcomeCode: "access_denied"
          });
          assert.deepInclude(
            yield* call("pidgeon.write", "closed", "messages.send", email("dev-closed-01")),
            { status: "sent" }
          );
        }),
      30_000
    );

    it.effect(
      "shares the address's slots with published reads, and checks the key again after waiting",
      () =>
        Effect.gen(function* () {
          const minted = yield* mint(DEV_SEED.userId, "Desk slots");
          const handlers = yield* PidgeonOperations.makeHandlers.pipe(
            Effect.provide(Directory.layer)
          );
          const labels = PidgeonTest.route("GET", "/labels");
          const lists = PidgeonTest.route("GET", "/threads");
          const release = yield* Deferred.make<void>();
          const before = heard().length;
          // A published desk fills the address's four slots through the same Source.
          mail.hold(labels, release, 4);
          const now = yield* Clock.currentTimeMillis;
          const holding = yield* Effect.forEach([1, 2, 3, 4], () =>
            handlers["pidgeon.read"]
              .run({ connection: "support", operation: "labels.list", input: {} })
              .pipe(
                Effect.provideService(Binding.Binding, publishedDesk(now)),
                Effect.exit,
                Effect.forkChild
              )
          );
          while (heard().slice(before).filter(labels).length < 4) yield* Effect.sleep("10 millis");
          const { call } = yield* desk(minted.token);
          const waiting = yield* call("pidgeon.read", "support", "threads.list", {}).pipe(
            Effect.flip,
            Effect.forkChild
          );
          const sql = yield* SqlClient.SqlClient;
          while (
            (yield* sql`SELECT 1 FROM runtime_calls
              WHERE credential_kind = 'machine' AND resource = 'threads.list' AND outcome = 'pending'`)
              .length === 0
          )
            yield* Effect.sleep("10 millis");
          yield* (yield* MachineTokens.MachineTokens).revoke(minted.id);
          yield* Deferred.succeed(release, undefined);
          for (const fiber of holding) yield* Fiber.join(fiber);
          const refused = yield* Fiber.join(waiting);
          assert.instanceOf(refused, DevDoor.KeyRefused);
          assert.isString(Runtime.toFailure(refused).correlationId);
          // The waiting read never reached Pidgeon.
          assert.lengthOf(heard().slice(before).filter(lists), 0);
        }),
      30_000
    );
  }
);

const limited = layer.pipe(
  Layer.provide(Layer.succeed(ContractLimits.overrides, { "runtime.calls.perMinute": 2 }))
);

it.layer(limited, { excludeTestServices: true, timeout: "60 seconds" })(
  "the per-person limit",
  (it) => {
    it.effect(
      "holds across every repo the person reads from, since it names no patch",
      () =>
        Effect.gen(function* () {
          const first = yield* mint(DEV_SEED.userId, "First laptop");
          const second = yield* mint(DEV_SEED.userId, "Second laptop");
          yield* query(first.token);
          yield* query(second.token);
          const refused = yield* query(first.token).pipe(Effect.flip);
          assert.strictEqual(refused.code, "rate_limited");
          assert.deepInclude(Runtime.toFailure(refused), { limitId: "runtime.calls.perMinute" });
          assert.isNumber(Runtime.toFailure(refused).retryAfter);
          assert.deepInclude((yield* devCalls)[0], { outcomeCode: "rate_limited" });
        }),
      30_000
    );

    it.effect(
      "holds across integrations too: PostHog queries and Pidgeon reads count together",
      () =>
        Effect.gen(function* () {
          const minted = yield* mint(member, "Shared limit");
          const { call } = yield* desk(minted.token);
          yield* query(minted.token);
          yield* call("pidgeon.read", "support", "threads.list", {});
          const refused = yield* call("pidgeon.read", "support", "threads.list", {}).pipe(
            Effect.flip
          );
          assert.deepInclude(Runtime.toFailure(refused), {
            code: "rate_limited",
            limitId: "runtime.calls.perMinute"
          });
        }),
      30_000
    );
  }
);

/** The runtime log, except that a dev read's row can't be written. */
const unloggable = Layer.effect(
  RuntimeLog.RuntimeLog,
  Effect.map(RuntimeLog.make, (log) =>
    RuntimeLog.RuntimeLog.of({
      ...log,
      begin: (input) =>
        input.credentialKind === "machine"
          ? Effect.fail(
              new SqlError({ reason: new ConnectionError({ cause: new Error("log down") }) })
            )
          : log.begin(input)
    })
  )
);

it.layer(serve(unloggable), { excludeTestServices: true, timeout: "60 seconds" })(
  "an unloggable read",
  (it) => {
    it.effect(
      "is refused before PostHog or Pidgeon hears of it",
      () =>
        Effect.gen(function* () {
          yield* connection;
          const before = queries().length;
          const refused = yield* query(DEV_SEED.token).pipe(Effect.flip);
          assert.strictEqual(refused.code, "source_unavailable");
          assert.strictEqual(queries().length, before);
          const { call } = yield* desk(DEV_SEED.token);
          const heardBefore = heard().length;
          const unread = yield* call("pidgeon.read", "support", "threads.list", {}).pipe(
            Effect.flip
          );
          assert.strictEqual(unread.code, "source_unavailable");
          assert.strictEqual(heard().length, heardBefore);
        }),
      30_000
    );
  }
);

it.live(
  "maps what answers before the door: the per-address limit and a bare 401",
  () =>
    Effect.gen(function* () {
      const answers = [
        {
          status: 429,
          type: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "Rate limit exceeded.",
            code: "rate_limited",
            retryAfterSeconds: 12
          })
        },
        { status: 401, type: "text/plain", body: "Unauthorized" }
      ];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((request, response) => {
            request.resume();
            const answer = answers.shift()!;
            response.writeHead(answer.status, { "content-type": answer.type });
            response.end(answer.body);
          })
        ),
        (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)))
      );
      yield* Effect.callback<void>(
        (resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void))
      );
      const address = server.address();
      if (address === null || typeof address === "string") return assert.fail("Expected TCP");
      const handlers = yield* PostHogDev.handlers({
        apiUrl: `http://127.0.0.1:${address.port}`,
        token: Option.some(Redacted.make("pp_machine_key"))
      }).pipe(Effect.provide(FetchHttpClient.layer));
      const call = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        handlers["posthog.query"].run({ connection: "analytics", ...read }).pipe(
          Effect.provideService(
            Binding.Binding,
            local(
              {
                analytics: { kind: "posthog", id: "conn_product", handle: "product", revision: 1 }
              },
              now
            )
          ),
          Effect.flip
        )
      );
      assert.deepInclude(Runtime.toFailure(yield* call), {
        code: "rate_limited",
        limitId: "rate.protectedApi.perMinute",
        scope: "host",
        retryAfter: 12
      });
      assert.instanceOf(yield* call, DevDoor.KeyRefused);
    }),
  { timeout: 30_000 }
);
