// @effect-diagnostics nodeBuiltinImport:off -- A stub answers on a real socket, as a proxy would.
import { createServer } from "node:http";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CURRENT_RELEASE,
  DevReadsGroup,
  PostgresRows,
  RuntimeFailure,
  WIRE_VERSION,
  PostHogDeclaration
} from "@patchy/api";
import { Authorization, MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { ContractLimits, Limits } from "@patchy/limits";
import { Binding, LoadedVersions, Runtime, RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
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
import * as DevReads from "./DevReads.js";
import * as PostgresSource from "./postgres/Source.js";
import * as PostHogDev from "./posthog/Dev.js";
import * as PostHogOperations from "./posthog/Operations.js";
import * as SqlConnectionStore from "./SqlConnectionStore.js";
import * as PostHogDouble from "./test/posthog.js";

/**
 * `patchy dev`'s PostHog binding against a real instance door: the endpoint on a socket over a
 * migrated database, its PostHog the double. Nothing reaches the network.
 */

type Declaration = typeof PostHogDeclaration.Type;
type Viewer = NonNullable<Binding.Binding["Service"]["identity"]>;

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
});

/** The runtime this door drains with; it serves no published versions here. */
const runtime = Layer.effect(
  Runtime.Runtime,
  Runtime.make(
    {},
    {
      origin: "https://patchy.example",
      identity: Effect.fail(new Runtime.AccessDenied({})),
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
        Layer.provide([
          PostgresSource.layer,
          CredentialKeys.layerFromKeys(
            Redacted.make(`dev-reads:${Buffer.alloc(32, 3).toString("base64")}`)
          )
        ]),
        Layer.provideMerge(double.layer)
      )
    ),
    Layer.provideMerge(Layer.mergeAll(MachineTokens.layer, log, Limits.layer)),
    Layer.provideMerge(Layer.effectDiscard(seed).pipe(Layer.provideMerge(Testing.layer())))
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

/** A local dev binding, as `patchy dev` admits either viewer. */
const local = (declaration: Declaration, now: number, viewer: Viewer = owner) =>
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
      uses: { analytics: declaration }
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
        local(declaration, yield* Clock.currentTimeMillis, options.viewer)
      )
    );
});

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
            assert.instanceOf(refused, PostHogDev.KeyRefused, label);
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
          const post = (body: unknown, authorization = `Bearer ${DEV_SEED.token}`) =>
            Effect.promise(async () => {
              const response = await fetch(url, {
                method: "POST",
                headers: { authorization, "content-type": "application/json" },
                body: JSON.stringify(body)
              });
              return { status: response.status, body: (await response.json()) as unknown };
            });
          const refusal = Schema.decodeUnknownSync(RuntimeFailure);
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
          for (const args of [
            { ...read, name: "nul\u0000name" },
            { ...read, query: "SELECT\u0000 1" }
          ]) {
            const nul = yield* post({ op: "posthog.query", connection: connection_, args });
            assert.strictEqual(nul.status, 400);
            assert.strictEqual(
              refusal(nul.body).correlationId,
              (yield* devCalls)[0]!.correlationId
            );
          }

          const before = (yield* devCalls).length;
          // A body that never declares its length is cut off at the bound as it streams.
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
                  for (let sent = 0; sent < 5; sent++) controller.enqueue(chunk);
                  controller.close();
                }
              })
            } as RequestInit & { duplex: "half" });
            return { status: response.status, body: (await response.json()) as unknown };
          });
          assert.strictEqual(streamed.status, 413);
          assert.deepInclude(refusal(streamed.body), {
            code: "too_large",
            limitId: "runtime.posthog.bytes"
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
                  ...local(declaration, now),
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
          assert.instanceOf(refused, PostHogDev.KeyRefused);
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
                Effect.provideService(Binding.Binding, local(declaration, now)),
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
          assert.instanceOf(unreachable, PostHogDev.InstanceUnavailable);
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
      "is refused before PostHog hears of it",
      () =>
        Effect.gen(function* () {
          yield* connection;
          const before = queries().length;
          const refused = yield* query(DEV_SEED.token).pipe(Effect.flip);
          assert.strictEqual(refused.code, "source_unavailable");
          assert.strictEqual(queries().length, before);
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
        handlers["posthog.query"]
          .run({ connection: "analytics", ...read })
          .pipe(
            Effect.provideService(
              Binding.Binding,
              local({ kind: "posthog", id: "conn_product", handle: "product", revision: 1 }, now)
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
      assert.instanceOf(yield* call, PostHogDev.KeyRefused);
    }),
  { timeout: 30_000 }
);
