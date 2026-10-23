import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CURRENT_RELEASE, RuntimeGroup, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  LoadedVersions,
  RuntimeApi,
  RuntimeLog,
  RuntimeProduction,
  StreamAdmission
} from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as SqlClient from "effect/sql/SqlClient";
import { build } from "esbuild";
import { expect } from "vitest";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as Source from "../src/posthog/Source.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as Operations from "../src/posthog/Operations.js";
import { generate } from "../src/posthog/Generate.js";
import * as PostHogDouble from "../src/test/posthog.js";
import { loadPiece } from "./adapter.js";
import { makeSource } from "./posthog.js";

// These are invented, nonfunctional keys, never provider credentials.
const a = {
  companyId: DEV_SEED.companyId,
  userId: DEV_SEED.userId,
  sub: DEV_SEED.clerkUserId,
  projectId: 101,
  key: "phx_mockCustomerA0000001",
  patchId: "apcustomer01"
};
const b = {
  companyId: "cmp_ap_b",
  userId: "usr_ap_b",
  sub: "user_ap_b",
  projectId: 202,
  key: "phx_mockCustomerB0000002",
  patchId: "apcustomer02"
};
const snapshot = { version: 1 as const, events: [], eventProperties: [], personProperties: [] };
const double = PostHogDouble.make(
  PostHogDouble.project(
    ...[a, b].map((customer) => ({
      region: "us" as const,
      id: customer.projectId,
      key: customer.key
    }))
  )
);
const fixture = SqlConnectionStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CredentialKeys.layerFromKeys(
        Redacted.make(`prototype:${Buffer.alloc(32, 71).toString("base64")}`)
      ),
      RuntimeLog.layer,
      double.layer,
      PostgresSource.layer
    )
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Session.layer,
      Companies.layer,
      Users.layer,
      Limits.layer,
      OperatingLimits.layer,
      NodeServices.layer,
      WideEvents.layerNoop
    )
  ),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const TestApi = HttpApi.make("patchy").add(
  RuntimeGroup.add(
    HttpApiEndpoint.post("call", "/api/runtime/call", {
      headers: Schema.Record(Schema.String, Schema.String),
      payload: Schema.Unknown,
      success: Schema.Unknown
    })
  )
);

/** A real loopback HTTP socket serving SIMULATED PostHog, not a real provider. */
const mockProvider = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Array<{ projectId: number; authorization: string | undefined; body: unknown }> =
      [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        query: { query: string };
        name: string;
      };
      const projectId = Number(req.url?.match(/^\/api\/projects\/(\d+)\/query\/$/)?.[1]);
      requests.push({ projectId, authorization: req.headers.authorization, body });
      const customer = [a, b].find(
        (c) => c.projectId === projectId && req.headers.authorization === `Bearer ${c.key}`
      );
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST" || customer === undefined) {
        res.writeHead(401).end(JSON.stringify({ detail: "Mock key rejected" }));
      } else if (body.query.query.includes("provider_error")) {
        // Deliberately hostile upstream error: it must not reach patch output or call logs.
        res.writeHead(403).end(JSON.stringify({ detail: customer.key }));
      } else {
        res.end(
          JSON.stringify({
            columns: ["n"],
            types: [["n", "UInt64"]],
            results: [[projectId]],
            hasMore: false
          })
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No mock port");
    return { server, requests, url: `http://127.0.0.1:${address.port}` };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
);

it.layer(fixture)(
  "Activepieces prototype — MOCK provider; real storage, crypto and runtime",
  (it) => {
    it.effect(
      "runs the unchanged action for two companies through generated clients; denies tenant crossing before HTTP",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO companies (id, handle, name) VALUES (${b.companyId}, 'ap-customer-b', 'Customer B')`;
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${b.userId}, ${b.sub}, ${b.companyId}, 'b@prototype.test', 'Customer B', 'admin')`;
          const store = yield* ConnectionStore.ConnectionStore;
          const connections: ConnectionStore.Connection[] = [];
          for (const customer of [a, b])
            connections.push(
              yield* store.connect({
                integration: "posthog",
                companyId: customer.companyId,
                userId: customer.userId,
                handle: "analytics",
                description: "Disposable prototype connection",
                credentials: Source.credentials({
                  region: "us",
                  projectId: customer.projectId,
                  apiKey: customer.key
                })
              })
            );
          const [connA, connB] = connections;
          assert.isDefined(connA);
          assert.isDefined(connB);
          const declare = (connection: ConnectionStore.Connection) => ({
            kind: "posthog" as const,
            id: connection.id,
            handle: connection.handle,
            revision: connection.metadataRevision
          });
          const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
          const poisonedVersion = "ver_bbbbbbbbbbbbbbbbbbbbbbbb";
          const versions = LoadedVersions.LoadedVersions.of({
            find: (patch, version = versionId) => {
              const index = [a, b].findIndex((c) => c.patchId === patch);
              if (index === -1 || ![versionId, poisonedVersion].includes(version))
                return Effect.succeed(Option.none());
              return Effect.succeed(
                Option.some({
                  patchId: patch,
                  versionId: version,
                  patchTier: 1,
                  companyId: [a, b][index]!.companyId,
                  scope: "company" as const,
                  wireVersion: WIRE_VERSION,
                  manifest: {
                    manifestVersion: 1,
                    release: CURRENT_RELEASE,
                    tier: 1 as const,
                    tables: {},
                    files: {},
                    uses: {
                      analytics: declare(
                        connections[version === poisonedVersion ? 1 - index : index]!
                      )
                    }
                  }
                })
              );
            }
          });
          const provider = yield* mockProvider;
          // eslint-disable-next-line no-restricted-properties -- Observe the dependency's process-global TLS side effect in this harness.
          const parentTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          const source = yield* makeSource(() => provider.url);
          const handlers = yield* Operations.makeHandlers.pipe(
            Effect.provideService(Source.Source, source)
          );
          const api = yield* HttpApiTest.groups(TestApi, ["runtime"], {
            baseUrl: PUBLIC_BASE_URL
          }).pipe(
            Effect.provide(
              Layer.mergeAll(RuntimeApi.layer, HttpServer.layerServices).pipe(
                Layer.provide(RuntimeProduction.layer(handlers)),
                Layer.provide(StreamAdmission.layer),
                Layer.provide(Layer.succeed(LoadedVersions.LoadedVersions, versions))
              )
            )
          );
          const run = yield* FiberSet.makeRuntimePromise();
          const transport =
            (viewer: typeof a | typeof b, patch = viewer.patchId, version = versionId) =>
            (op: string, args: unknown) =>
              run(
                api
                  .call({
                    payload: {
                      patchId: patch,
                      versionId: version,
                      principal: { userId: viewer.userId },
                      wire: WIRE_VERSION,
                      op,
                      args
                    },
                    headers: {
                      "x-patchy-wire": String(WIRE_VERSION),
                      "x-patchy-principal": JSON.stringify({ userId: viewer.userId }),
                      origin: PUBLIC_BASE_URL,
                      cookie: signedInCookies(
                        signSession({
                          sub: viewer.sub,
                          email: viewer.userId === a.userId ? DEV_SEED.email : "b@prototype.test",
                          name: viewer.userId === a.userId ? DEV_SEED.userName : "Customer B"
                        })
                      )
                    },
                    responseMode: "response-only"
                  })
                  .pipe(
                    Effect.flatMap((response) => response.json),
                    Effect.map((body) => {
                      const envelope = body as { ok?: boolean; value?: unknown };
                      return envelope.ok === true ? envelope.value : body;
                    })
                  )
              );
          // Execute the actual generated browser client, bundled with the existing Patchy client.
          const bundle = yield* Effect.promise(() =>
            build({
              stdin: {
                contents: generate(declare(connA!), snapshot).client,
                resolveDir: new URL("../../patchy", import.meta.url).pathname,
                loader: "ts"
              },
              bundle: true,
              write: false,
              platform: "browser",
              format: "esm",
              target: "es2022"
            })
          );
          const generated = yield* Effect.promise(
            () =>
              import(
                `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
              ) as Promise<{
                createClient: (
                  alias: string,
                  call: (op: string, args: unknown) => Promise<unknown>
                ) => {
                  query: (request: unknown) => Promise<unknown>;
                };
              }>
          );
          const request = {
            name: "prototype",
            query: "SELECT 1 AS n",
            shape: { n: { kind: "integer" } }
          };
          const clientA = generated.createClient("analytics", transport(a));
          const clientB = generated.createClient("analytics", transport(b));
          assert.deepStrictEqual(yield* Effect.promise(() => clientA.query(request)), {
            ok: true,
            rows: [{ n: 101 }]
          });
          assert.deepStrictEqual(yield* Effect.promise(() => clientB.query(request)), {
            ok: true,
            rows: [{ n: 202 }]
          });
          assert.deepStrictEqual(
            provider.requests.map((r) => [r.projectId, r.authorization]),
            [
              [a.projectId, `Bearer ${a.key}`],
              [b.projectId, `Bearer ${b.key}`]
            ]
          );
          assert.deepStrictEqual(provider.requests[0]!.body, {
            query: { kind: "HogQLQuery", query: request.query },
            name: "activepieces"
          });
          const refusal = (
            client: ReturnType<typeof generated.createClient>,
            input: unknown = request
          ) =>
            Effect.promise(() =>
              client.query(input).then(
                () => assert.fail("Expected refusal"),
                (error: unknown) => error
              )
            );
          // Company A's actual signed-in viewer cannot open B's patch.
          assert.include(
            yield* refusal(generated.createClient("analytics", transport(a, b.patchId))),
            { code: "access_denied" }
          );
          // Even a corrupt published declaration pointing at the other company's connection is refused.
          assert.include(
            yield* refusal(
              generated.createClient("analytics", transport(a, a.patchId, poisonedVersion))
            ),
            { code: "access_denied" }
          );
          assert.include(
            yield* refusal(
              generated.createClient("analytics", transport(b, b.patchId, poisonedVersion))
            ),
            { code: "access_denied" }
          );
          assert.include(yield* refusal(generated.createClient("undeclared", transport(a))), {
            code: "connection_not_declared"
          });
          assert.include(yield* refusal(clientA, { ...request, values: { n: 7 } }), {
            code: "invalid_query"
          });
          const injected = yield* Effect.promise(() =>
            transport(a)("posthog.query", {
              ...request,
              connection: "analytics",
              auth: { personal_api_key: b.key },
              companyId: b.companyId
            })
          );
          assert.include(injected, { code: "invalid_request" });
          assert.lengthOf(provider.requests, 2);
          const encrypted =
            yield* sql`SELECT credentials FROM connections WHERE id IN (${connA!.id}, ${connB!.id})`;
          for (const row of encrypted)
            for (const customer of [a, b]) assert.notInclude(JSON.stringify(row), customer.key);
          assert.strictEqual(
            (yield* store.poolCredentials(a.companyId, declare(connB!), 1).pipe(Effect.flip)).code,
            "connection_not_connected"
          );
          // Encryption's associated data rejects transplanting even a valid ciphertext to another company.
          const keys = yield* CredentialKeys.CredentialKeys;
          const identity = {
            companyId: a.companyId,
            id: connA!.id,
            integration: "posthog" as const
          };
          const cipher = yield* keys.encrypt(identity, Redacted.make(a.key));
          assert.strictEqual(
            (yield* keys.decrypt({ ...identity, companyId: b.companyId }, cipher).pipe(Effect.flip))
              .code,
            "credential_decryption_failed"
          );
          const upstreamError = yield* refusal(clientA, {
            ...request,
            query: "SELECT provider_error"
          });
          assert.include(upstreamError, { code: "source_unavailable" });
          for (const customer of [a, b])
            assert.notInclude(JSON.stringify(upstreamError), customer.key);
          yield* store.disconnect({ companyId: a.companyId, userId: a.userId, id: connA!.id });
          assert.include(yield* refusal(clientA), { code: "access_denied" });
          assert.lengthOf(provider.requests, 3);
          yield* store.reconnect({ companyId: a.companyId, userId: a.userId, id: connA!.id });
          assert.deepStrictEqual(yield* Effect.promise(() => clientA.query(request)), {
            ok: true,
            rows: [{ n: 101 }]
          });
          const log = yield* RuntimeLog.RuntimeLog;
          for (const [customer, connection] of [
            [a, connA!],
            [b, connB!]
          ] as const) {
            const calls = yield* log.recent({
              companyId: customer.companyId,
              connectionId: connection.id
            });
            const successes = calls.filter(
              (call) => call.op === "posthog.query" && call.outcome === "success"
            );
            assert.isAtLeast(successes.length, 1);
            assert.isTrue(
              successes.every((call) => call.userId === customer.userId && call.rowCount === 1)
            );
            for (const other of [a, b]) assert.notInclude(JSON.stringify(calls), other.key);
          }
          const deniedAttempts = yield* log.recent({
            companyId: a.companyId,
            connectionId: connB!.id
          });
          assert.isTrue(
            deniedAttempts.every(
              (call) => call.userId === a.userId && call.outcomeCode === "access_denied"
            )
          );
          const bCalls = yield* log.recent({ companyId: b.companyId, connectionId: connB!.id });
          const bSuccess = bCalls.find(
            (call) => call.op === "posthog.query" && call.outcome === "success"
          )!;
          assert.isNull(
            yield* log.find({ companyId: a.companyId, correlationId: bSuccess.correlationId })
          );
          // eslint-disable-next-line no-restricted-properties -- The module may alter only its disposable worker's TLS environment.
          assert.strictEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, parentTls);
        }).pipe(Effect.scoped)
    );
  }
);

it.effect(
  "loads the existing piece; admits only the host's selected action and fails closed on unsupported context",
  () =>
    Effect.promise(async () => {
      const module = {
        modulePath: createRequire(import.meta.url).resolve("@activepieces/piece-posthog"),
        exportName: "posthog"
      };
      const adapter = await loadPiece(module, ["run_hogql_query"]);
      assert.isAbove(adapter.actions.length, 1);
      await expect(adapter.run("create_event", {}, {})).rejects.toThrow("Action not enabled");
      const modulePath = new URL("./fixture.cjs", import.meta.url).pathname;
      await expect(loadPiece({ modulePath, exportName: "oauth" }, [])).rejects.toThrow("API-key");
      const needsStore = await loadPiece({ modulePath, exportName: "needsStore" }, ["unsupported"]);
      await expect(needsStore.run("unsupported", "dummy", {})).rejects.toThrow(
        "Unsupported action context"
      );
    })
);
