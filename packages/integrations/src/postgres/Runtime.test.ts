import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { CURRENT_RELEASE, GuestProtocol, RuntimeFailure, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  CallbackGateway,
  InvocationCapabilities,
  LoadedVersions,
  RuntimeLog
} from "@patchy/runtime";
import * as Callbacks from "../../../runtime/src/test/callbacks.js";
import * as Testing from "@patchy/sql/testing";
import * as ConnectionStore from "../ConnectionStore.js";
import * as ConnectionStoreDev from "../ConnectionStoreDev.js";
import * as Execution from "./Execution.js";
import * as Operations from "./Operations.js";
import { nativeExecution } from "../test/nativeExecution.js";
import type { Snapshot } from "@patchy/api/postgres-snapshot";
import { NodeCryptography } from "@patchy/core";

const declaration = {
  kind: "postgres" as const,
  id: "con_runtime",
  handle: "warehouse",
  revision: 1
};
const patchId = "postgresflow";
const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
const snapshot: typeof Snapshot.Type = {
  version: 1,
  enums: [],
  exclusions: [],
  relations: [
    {
      schema: "public",
      name: "orders",
      kind: "table",
      primaryKey: { name: "orders_pk", columns: ["id"] },
      foreignKeys: [],
      columns: [
        {
          name: "id",
          nullable: false,
          type: {
            schema: "pg_catalog",
            name: "int4",
            sql: "integer",
            baseSchema: "pg_catalog",
            baseName: "int4",
            kind: "base"
          }
        }
      ]
    }
  ]
};
const connection = {
  id: declaration.id,
  companyId: DEV_SEED.companyId,
  integration: "postgres",
  handle: declaration.handle,
  description: "Runtime fixture",
  mode: "company",
  status: "connected",
  credentialRevision: 1,
  metadataRevision: 1,
  display: { host: "fixture.invalid", port: 5432, database: "fixture", role: "reader" },
  lastTestedAt: null,
  lastDiscoveredAt: null,
  createdBy: DEV_SEED.userId
} satisfies ConnectionStore.Connection;
const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);
const identity = {
  user: { id: DEV_SEED.userId, name: "Viewer", email: "viewer@example.test" },
  company: { id: DEV_SEED.companyId, handle: "dev", name: "Dev" },
  admin: false
};
/** The tier 2 version an action runs in, declaring the connection its handlers call back to. */
const binding = {
  ...Callbacks.binding,
  companyId: DEV_SEED.companyId,
  patchId,
  versionId,
  principal: { userId: DEV_SEED.userId },
  identity,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2 as const,
    tables: {},
    files: {},
    uses: { sales: declaration },
    handlers: {}
  }
};
const versions = Layer.succeed(LoadedVersions.LoadedVersions, {
  find: (patch, version) =>
    Effect.succeed(
      patch === patchId && (version === undefined || version === versionId)
        ? Option.some({ ...binding, patchTier: 2, wireVersion: WIRE_VERSION })
        : Option.none()
    )
});
const services = Layer.mergeAll(
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

it.layer(services)("declared Postgres from a tier 2 action", (it) => {
  it.effect(
    "dispatches every operation and attributes real source successes and read-only failures",
    () =>
      Effect.gen(function* () {
        // The source is this block's own database, read through native execution.
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE TABLE public.orders (id integer PRIMARY KEY)");
        yield* sql.unsafe("INSERT INTO public.orders VALUES (1), (2)");
        const store = yield* ConnectionStore.ConnectionStore.pipe(
          Effect.provide(
            ConnectionStoreDev.layer([
              {
                connection,
                snapshots: [{ revision: 1, metadata: { integration: "postgres", snapshot } }]
              }
            ])
          )
        );
        const execution = yield* nativeExecution(store, {
          ...Execution.specLimits,
          maxBytes: 1024
        });
        yield* Effect.gen(function* () {
          const handlers = yield* Operations.makeHandlers;
          const capabilities = yield* InvocationCapabilities.make;
          const gateway = yield* CallbackGateway.make(handlers).pipe(
            Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities)
          );
          const capability = yield* Callbacks.issue(capabilities, {
            kind: "action",
            binding,
            reauthorize: Effect.succeed(identity)
          });
          const send = (op: string, args: GuestProtocol.Callback["args"]) =>
            gateway.callback(capability.token, capability.attempt, { op, args });
          /** The refusal a callback answered with; a success fails to decode as one. */
          const refusal = (op: string, args: GuestProtocol.Callback["args"]) =>
            send(op, args).pipe(Effect.map(decodeFailure));
          const relation = { schema: "public", name: "orders" };
          for (const [op, args, rows] of [
            ["postgres.list", { connection: "sales", relation }, [{ id: 1 }, { id: 2 }]],
            ["postgres.get", { connection: "sales", relation, key: { id: 2 } }, [{ id: 2 }]],
            [
              "postgres.getMany",
              { connection: "sales", relation, keys: [{ id: 2 }, { id: 99 }, { id: 1 }] },
              [{ id: 2 }, null, { id: 1 }]
            ],
            [
              "postgres.query",
              {
                connection: "sales",
                sql: "SELECT $1::integer AS id",
                params: [7],
                shape: { id: { kind: "integer" } }
              },
              [{ id: 7 }]
            ]
          ] as const) {
            assert.deepStrictEqual(yield* send(op, args), {
              ok: true,
              value: { ok: true, rows, ...(op === "postgres.list" ? { cursor: null } : {}) }
            });
          }
          const failure = yield* refusal("postgres.query", {
            connection: "sales",
            sql: "INSERT INTO public.orders VALUES ($1) RETURNING id",
            params: [3],
            shape: { id: { kind: "integer" } }
          });
          assert.strictEqual(failure.code, "invalid_query");
          assert.strictEqual(failure.details?.sqlstate, "25006");
          const log = yield* RuntimeLog.RuntimeLog;
          const failed = yield* log.find({
            companyId: DEV_SEED.companyId,
            correlationId: failure.correlationId!
          });
          assert.strictEqual(failed?.connectionId, declaration.id);
          assert.strictEqual(failed?.userId, DEV_SEED.userId);
          assert.strictEqual(failed?.outcomeCode, "invalid_query");
          assert.strictEqual(failed?.sql, "INSERT INTO public.orders VALUES ($1) RETURNING id");
          // Postgres text can't hold NUL, so the log keeps a stand-in and the query is still refused.
          const nulFailure = yield* refusal("postgres.query", {
            connection: "sales",
            sql: "SELECT 1\u0000",
            params: [],
            shape: { id: { kind: "integer" } }
          });
          assert.strictEqual(nulFailure.code, "invalid_request");
          const nulCall = yield* log.find({
            companyId: DEV_SEED.companyId,
            correlationId: nulFailure.correlationId!
          });
          assert.strictEqual(nulCall?.outcomeCode, "invalid_request");
          assert.strictEqual(nulCall?.sql, "SELECT 1\uFFFD");
          const recent = yield* log.recent({
            companyId: DEV_SEED.companyId,
            connectionId: declaration.id
          });
          assert.deepStrictEqual(
            recent.filter((call) => call.op !== "postgres.query").map((call) => call.sql),
            [null, null, null]
          );
          assert.deepStrictEqual(
            recent
              .filter((call) => call.outcome === "success")
              .map((call) => [call.op, call.rowCount])
              .sort(),
            [
              ["postgres.get", 1],
              ["postgres.getMany", 2],
              ["postgres.list", 2],
              ["postgres.query", 1]
            ]
          );
          const rowFailure = yield* refusal("postgres.list", {
            connection: "sales",
            relation,
            limit: 1001
          });
          assert.strictEqual(rowFailure.code, "too_large");
          assert.notProperty(rowFailure, "limitId");
          assert.notProperty(rowFailure, "scope");
          assert.notProperty(rowFailure, "value");
          const resultFailure = yield* refusal("postgres.query", {
            connection: "sales",
            sql: "SELECT repeat('x', 1025) AS value",
            params: [],
            shape: { value: { kind: "text" } }
          });
          assert.include(resultFailure, {
            code: "too_large",
            scope: "viewer",
            limitId: "runtime.result.bytes",
            value: 1024
          });
          assert.notProperty(resultFailure, "retryAfter");
        }).pipe(
          Effect.provideService(Execution.Execution, execution),
          Effect.provideService(ConnectionStore.ConnectionStore, store)
        );
      }).pipe(Effect.scoped)
  );
});
