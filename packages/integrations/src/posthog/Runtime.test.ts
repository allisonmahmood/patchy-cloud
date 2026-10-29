import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CURRENT_RELEASE, RuntimeGroup, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { newInternalId, sha256 } from "../../../../test/crypto.js";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  Binding,
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  LoadedVersions,
  Runtime,
  RuntimeApi,
  RuntimeLog,
  RuntimeProduction,
  ServerBundles,
  StreamAdmission
} from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import { build } from "esbuild";
import * as CompanyTesting from "../../../company-database/src/testing.js";
import * as Local from "../../../execution/src/local.js";
import * as MutationTransaction from "../../../primitives/src/MutationTransaction.js";
import * as QuerySnapshot from "../../../primitives/src/QuerySnapshot.js";
import * as TestWakes from "../../../primitives/src/test/wakes.js";
import * as ConnectionStore from "../ConnectionStore.js";
import * as ConnectionStoreDev from "../ConnectionStoreDev.js";
import * as PostHogDouble from "../test/posthog.js";
import { generate } from "./Generate.js";
import * as Operations from "./Operations.js";

/**
 * PostHog journeys against the double: the generated tier 1 client over the runtime wire with a
 * signed-in viewer, and a tier 2 action in real workerd through the callback gateway. Both use
 * the packed `patchy` package, never its source.
 */

const patchy = new URL("../../../patchy", import.meta.url).pathname;
const declaration = {
  kind: "posthog" as const,
  id: "conn_journey",
  handle: "product",
  revision: 1
};
const project = {
  region: "us",
  id: 12345,
  key: "phx_journeyKey000001",
  query: ({ query, values }) =>
    query.includes("FROM events")
      ? PostHogDouble.rows(
          [
            ["day", "DateTime('UTC')"],
            ["views", "UInt64"]
          ],
          [
            ["2026-10-01T00:00:00Z", 12],
            ["2026-10-02T00:00:00Z", values?.event === "$pageview" ? 30 : 0]
          ]
        )
      : PostHogDouble.json(400, {
          type: "validation_error",
          code: "syntax_error",
          detail: "Unknown table"
        })
} satisfies PostHogDouble.Project;
const connection = {
  id: declaration.id,
  companyId: DEV_SEED.companyId,
  integration: "posthog",
  handle: declaration.handle,
  description: "Journey analytics",
  mode: "company",
  status: "connected",
  display: { region: "us", projectId: project.id, keyHint: "phx_…0001" },
  credentialRevision: 1,
  metadataRevision: 1,
  lastTestedAt: null,
  lastDiscoveredAt: null,
  createdBy: DEV_SEED.userId
} satisfies ConnectionStore.Connection;
const snapshot = {
  version: 1 as const,
  events: [{ name: "$pageview" }],
  eventProperties: [],
  personProperties: []
};
const query = {
  name: "dailyViews",
  query:
    "SELECT toStartOfDay(timestamp) AS day, count() AS views FROM events WHERE event = {event} GROUP BY day LIMIT 100",
  values: { event: "$pageview" }
};
const expected = [
  { day: "2026-10-01T00:00:00.000000Z", views: 12 },
  { day: "2026-10-02T00:00:00.000000Z", views: 30 }
];

/** The PostHog handler over the double, as the server builds it, with what PostHog received. */
const handlers = Effect.gen(function* () {
  const double = PostHogDouble.make(PostHogDouble.project(project));
  const store = yield* ConnectionStore.ConnectionStore.pipe(
    Effect.provide(
      ConnectionStoreDev.layer([
        { connection, snapshots: [{ revision: 1, metadata: { integration: "posthog", snapshot } }] }
      ])
    )
  );
  const live = ConnectionStore.ConnectionStore.of({
    ...store,
    poolCredentials: () => Effect.succeed(PostHogDouble.credentials(project))
  });
  const built = yield* Operations.makeHandlers.pipe(
    Effect.provide(double.layer),
    Effect.provideService(ConnectionStore.ConnectionStore, live)
  );
  return { handlers: built, requests: double.requests };
});

/** One module from the packed package's exports, bundled for the browser or a guest. */
const bundle = (contents: string, sourcefile: string) =>
  Effect.promise(() =>
    build({
      stdin: { contents, resolveDir: patchy, sourcefile, loader: "ts" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022"
    })
  ).pipe(Effect.map((result) => result.outputFiles[0]!.text));

const patchId = "posthogtier1";
const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
const versions = Layer.succeed(LoadedVersions.LoadedVersions, {
  find: (patch, version) =>
    Effect.succeed(
      patch === patchId && (version === undefined || version === versionId)
        ? Option.some({
            patchId,
            versionId,
            patchTier: 1,
            companyId: DEV_SEED.companyId,
            scope: "company" as const,
            wireVersion: WIRE_VERSION,
            manifest: {
              manifestVersion: 1,
              release: CURRENT_RELEASE,
              tier: 1 as const,
              tables: {},
              files: {},
              uses: { analytics: declaration }
            }
          })
        : Option.none()
    )
});
const TestApi = HttpApi.make("patchy").add(
  RuntimeGroup.add(
    HttpApiEndpoint.post("call", "/api/runtime/call", {
      headers: Schema.Record(Schema.String, Schema.String),
      payload: Schema.Unknown,
      success: Schema.Unknown
    })
  )
);
const tier1 = Layer.mergeAll(
  Session.layer,
  WideEvents.layerNoop,
  Companies.layer,
  Users.layer,
  Limits.layer,
  OperatingLimits.layer,
  RuntimeLog.layer,
  versions
)
  .pipe(
    Layer.provideMerge(Testing.layer()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
  )
  .pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCryptography.layer));

it.layer(tier1)("PostHog in a tier 1 page", (it) => {
  it.effect(
    "the generated client queries as the signed-in viewer, and the call is logged by name",
    () =>
      Effect.gen(function* () {
        const { handlers: built, requests } = yield* handlers;
        const api = yield* HttpApiTest.groups(TestApi, ["runtime"], {
          baseUrl: PUBLIC_BASE_URL
        }).pipe(
          Effect.provide(
            Layer.mergeAll(RuntimeApi.layer, HttpServer.layerServices).pipe(
              Layer.provide(RuntimeProduction.layer(built)),
              Layer.provide(StreamAdmission.layer)
            )
          )
        );
        // The shell's transport in miniature: one runtime call per client call, as the viewer.
        const run = yield* FiberSet.makeRuntimePromise();
        const call = (op: string, args: unknown) =>
          run(
            api
              .call({
                payload: {
                  patchId,
                  versionId,
                  principal: { userId: DEV_SEED.userId },
                  wire: WIRE_VERSION,
                  op,
                  args
                },
                headers: {
                  "x-patchy-wire": String(WIRE_VERSION),
                  "x-patchy-principal": `{"userId":"${DEV_SEED.userId}"}`,
                  origin: PUBLIC_BASE_URL,
                  cookie: signedInCookies()
                },
                responseMode: "response-only"
              })
              .pipe(
                Effect.flatMap((response) => response.json),
                Effect.map((body) =>
                  typeof body === "object" &&
                  body !== null &&
                  "ok" in body &&
                  body.ok === true &&
                  "value" in body
                    ? body.value
                    : body
                )
              )
          );
        const code = yield* bundle(
          generate({ ...declaration, description: "Journey analytics" }, snapshot).client,
          "analytics.ts"
        );
        const generated = yield* Effect.promise(
          () =>
            import(
              `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
            ) as Promise<{
              createClient: (
                alias: string,
                call: (op: string, args: unknown) => Promise<unknown>
              ) => {
                query: (request: unknown) => Promise<{ ok: true; rows: unknown[] }>;
              };
            }>
        );
        const analytics = generated.createClient("analytics", call);
        const result = yield* Effect.promise(() =>
          analytics.query({
            ...query,
            shape: { day: { kind: "timestamp" }, views: { kind: "integer" } }
          })
        );
        assert.deepStrictEqual(result, { ok: true, rows: expected });
        assert.deepStrictEqual(requests.at(-1)!.body, { query: { kind: "HogQLQuery", ...query } });

        const refused = yield* Effect.promise(() =>
          analytics
            .query({
              name: "broken",
              query: "SELECT * FROM evnts",
              shape: { n: { kind: "integer" } }
            })
            .then(
              () => undefined,
              (error: unknown) => error
            )
        );
        assert.include(refused, {
          name: "PatchyError",
          code: "invalid_query",
          operation: "posthog.query"
        });

        const log = yield* RuntimeLog.RuntimeLog;
        const calls = yield* log.recent({
          companyId: DEV_SEED.companyId,
          connectionId: declaration.id
        });
        // Both calls share the test clock's instant, so compare them by name.
        assert.deepStrictEqual(
          calls
            .map((call) => [
              call.op,
              call.resource,
              call.sql,
              call.outcome,
              call.rowCount,
              call.userId
            ])
            .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
          [
            ["posthog.query", "broken", "SELECT * FROM evnts", "failure", null, DEV_SEED.userId],
            ["posthog.query", "dailyViews", query.query, "success", 2, DEV_SEED.userId]
          ]
        );
      }).pipe(Effect.scoped)
  );
});

const tier2 = Layer.mergeAll(
  RuntimeLog.layer,
  InvocationLog.layer,
  OperatingLimits.layer,
  QuerySnapshot.layer,
  MutationTransaction.layer
).pipe(
  Layer.provideMerge(InvocationCapabilities.layer),
  Layer.provideMerge(CompanyTesting.layer()),
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(FetchHttpClient.layer)
);

it.layer(tier2, { excludeTestServices: true, timeout: 60_000 })(
  "PostHog in a tier 2 action",
  (it) => {
    it.effect(
      "an action in workerd reads PostHog through the gateway as its viewer",
      () =>
        Effect.gen(function* () {
          const { handlers: built, requests } = yield* handlers;
          const viewer = {
            user: { id: DEV_SEED.userId, name: "Dev", email: "dev@patchy.local" },
            company: { id: DEV_SEED.companyId, name: "Patchy Dev", handle: "patchy-dev" },
            admin: false
          };
          const binding = Binding.Binding.of({
            companyId: DEV_SEED.companyId,
            patchId: "posthogtier2",
            versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
            wireVersion: WIRE_VERSION,
            scope: "company",
            correlationId: "posthog-tier2",
            principal: { userId: viewer.user.id },
            identity: viewer,
            manifest: {
              manifestVersion: 1,
              release: CURRENT_RELEASE,
              tier: 2,
              tables: {},
              files: {},
              uses: { analytics: declaration },
              handlers: {
                "report.views": { kind: "action", args: {}, result: { kind: "json" } },
                "report.broken": { kind: "action", args: {}, result: { kind: "json" } }
              }
            }
          });
          const gateway = yield* CallbackGateway.make(built);
          const listener = yield* CallbackGatewayApi.listen().pipe(
            Effect.provideService(CallbackGateway.CallbackGateway, gateway)
          );
          const text = yield* bundle(
            `import { action, createGuest, t } from "patchy/server";
          const views = action({ args: {}, result: t.json(), handler: async (ctx) =>
            ctx.connections.analytics.query({
              name: ${JSON.stringify(query.name)},
              query: ${JSON.stringify(query.query)},
              values: ${JSON.stringify(query.values)},
              shape: { day: t.timestamp(), views: t.integer() }
            })
          });
          const broken = action({ args: {}, result: t.json(), handler: async (ctx) =>
            ctx.connections.analytics.query({
              name: "broken",
              query: "SELECT * FROM evnts",
              shape: { n: t.integer() }
            })
          });
          export default createGuest({ report: { views, broken } });`,
            "report.ts"
          );
          const guest: GuestProtocol.Bundle = {
            companyId: binding.companyId,
            patchId: binding.patchId,
            versionId: binding.versionId,
            bundle: text,
            sha256: sha256(text)
          };
          const executor = yield* Local.make({
            companyId: binding.companyId,
            callbackUrls: [listener.url],
            environment: "test"
          }).pipe(Effect.provide(WideEvents.layerNoop));
          const invocations = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
            Effect.provideService(Executor.Executor, executor),
            Effect.provideService(ServerBundles.ServerBundles, {
              load: () => Effect.succeed(guest)
            })
          );
          const result = yield* invocations.call(
            { handler: "report.views", args: {} },
            { ...binding, correlationId: newInternalId("call") },
            Effect.succeed(viewer)
          );
          assert.deepStrictEqual(result, { ok: true, value: { ok: true, rows: expected } });
          assert.deepStrictEqual(requests.at(-1)!.body, {
            query: { kind: "HogQLQuery", ...query }
          });

          // The action doesn't catch PostHog's refusal, so its caller gets it, still PostHog's.
          const refused = yield* invocations
            .call(
              { handler: "report.broken", args: {} },
              { ...binding, correlationId: newInternalId("call") },
              Effect.succeed(viewer)
            )
            .pipe(Effect.flip);
          assert.include(Runtime.toFailure(refused), {
            code: "invalid_query",
            operation: "posthog.query"
          });
        }),
      60_000
    );
  }
);
