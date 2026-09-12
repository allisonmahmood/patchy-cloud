import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import { CURRENT_RELEASE, RuntimeFailure, RuntimeGroup, WIRE_VERSION } from "@patchy/api";
import { Session } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import { LoadedVersions, RuntimeProduction, RuntimeApi, RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as ConnectionStore from "../ConnectionStore.js";
import * as ConnectionStoreDev from "../ConnectionStoreDev.js";
import * as Dev from "./Dev.js";
import * as Operations from "./Operations.js";
import type { Snapshot } from "@patchy/api/postgres-snapshot";

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
const connection = new ConnectionStore.Connection({
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
});
const versions = Layer.succeed(LoadedVersions.LoadedVersions, {
  find: (patch, version) =>
    Effect.succeed(
      patch === patchId && version === versionId
        ? Option.some({
            patchId,
            versionId,
            companyId: DEV_SEED.companyId,
            scope: "company" as const,
            wireVersion: WIRE_VERSION,
            manifest: {
              manifestVersion: 1,
              release: CURRENT_RELEASE,
              tier: 1 as const,
              tables: {},
              files: {},
              uses: { sales: declaration }
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
const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);
const services = Layer.mergeAll(
  Session.layer,
  Companies.layer,
  Users.layer,
  Limits.layer,
  RuntimeLog.layer,
  NodeServices.layer,
  versions
).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);

it.layer(services)("declared Postgres over the runtime wire", (it) => {
  it.effect(
    "dispatches every operation and attributes real source successes and read-only failures",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/fixtures`);
        yield* fs.writeFileString(
          `${root}/fixtures/postgres-warehouse.sql`,
          "INSERT INTO public.orders VALUES (1), (2);"
        );
        yield* Effect.gen(function* () {
          const handlers = yield* Operations.makeHandlers;
          const api = yield* HttpApiTest.groups(TestApi, ["runtime"], {
            baseUrl: PUBLIC_BASE_URL
          }).pipe(
            Effect.provide(
              Layer.mergeAll(RuntimeApi.layer, HttpServer.layerServices).pipe(
                Layer.provide(RuntimeProduction.layer(handlers))
              )
            )
          );
          const send = (op: string, args: unknown) =>
            api.call({
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
            });
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
            const response = yield* send(op, args);
            assert.strictEqual(response.status, 200);
            assert.deepStrictEqual(yield* response.json, {
              ok: true,
              value: { ok: true, rows, ...(op === "postgres.list" ? { cursor: null } : {}) }
            });
          }
          const refused = yield* send("postgres.query", {
            connection: "sales",
            sql: "INSERT INTO public.orders VALUES ($1) RETURNING id",
            params: [3],
            shape: { id: { kind: "integer" } }
          });
          const failure = decodeFailure(yield* refused.json);
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
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Dev.dev(snapshot, { root, connectionId: declaration.id, handle: declaration.handle }),
              ConnectionStoreDev.layer([{ connection, snapshots: [{ revision: 1, snapshot }] }])
            )
          )
        );
      })
  );
});
