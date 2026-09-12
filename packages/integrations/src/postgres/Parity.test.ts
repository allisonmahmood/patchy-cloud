import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, PostgresKeyRows, PostgresPage, WIRE_VERSION } from "@patchy/api";
import { Binding } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Pg from "pg";
import { inject } from "vitest";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Dev from "./Dev.js";
import * as Execution from "./Execution.js";
import { generate } from "./Generate.js";
import * as Operations from "./Operations.js";
import * as Source from "./Source.js";
import * as SourceClient from "./SourceClient.js";

const declaration = {
  kind: "postgres" as const,
  id: "connection-parity",
  handle: "warehouse",
  revision: 1
};
const binding = Binding.Binding.of({
  companyId: "cmp_parity",
  patchId: "parity01",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 1,
    tables: {},
    files: {},
    uses: { warehouse: declaration }
  },
  wireVersion: WIRE_VERSION,
  scope: "company",
  correlationId: "parity-test",
  principal: { userId: "usr_parity" },
  identity: {
    user: { id: "usr_parity", email: "member@example.test", name: "Member" },
    company: { id: "cmp_parity", handle: "parity", name: "Parity" },
    admin: false
  }
});
const connection = new ConnectionStore.Connection({
  companyId: binding.companyId,
  id: declaration.id,
  integration: "postgres",
  handle: declaration.handle,
  description: "Discovered native and dev parity",
  mode: "company",
  status: "connected",
  credentialRevision: 1,
  metadataRevision: 1,
  display: { host: "fixture.example", port: 5432, database: "fixture", role: "reader" },
  lastTestedAt: null,
  lastDiscoveredAt: null,
  createdBy: "usr_parity"
});
const relation = { schema: "public", name: "items" };
const request = { connection: "warehouse", relation };
const fixtureSql = "INSERT INTO public.items VALUES (1, ARRAY[1, 2]), (2, ARRAY[3])";
const expected = [
  { id: 1, values: [1, 2] },
  { id: 2, values: [3] }
];
const decodePage = Schema.decodeUnknownEffect(PostgresPage);
const decodeKeys = Schema.decodeUnknownEffect(PostgresKeyRows);

// The same handlers and pinned metadata are exercised with each real execution surface.
const exercise = Effect.gen(function* () {
  const handlers = yield* Operations.makeHandlers;
  const call = (op: keyof typeof handlers, args: unknown) =>
    handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
  assert.deepStrictEqual(yield* call("postgres.list", request).pipe(Effect.flatMap(decodePage)), {
    ok: true,
    rows: expected,
    cursor: null
  });
  assert.deepStrictEqual(
    yield* call("postgres.get", { ...request, key: { id: 1 } }).pipe(Effect.flatMap(decodeKeys)),
    { ok: true, rows: [expected[0]] }
  );
  assert.deepStrictEqual(
    yield* call("postgres.getMany", {
      ...request,
      keys: [{ id: 2 }, { id: 99 }, { id: 1 }]
    }).pipe(Effect.flatMap(decodeKeys)),
    { ok: true, rows: [expected[1], null, expected[0]] }
  );
  assert.deepStrictEqual(
    yield* call("postgres.list", { ...request, select: ["id"] }).pipe(Effect.flatMap(decodePage)),
    { ok: true, rows: [{ id: 1 }, { id: 2 }], cursor: null }
  );
  assert.deepStrictEqual(
    yield* call("postgres.list", { ...request, select: ["id"], eq: { id: 99 } }).pipe(
      Effect.flatMap(decodePage)
    ),
    { ok: true, rows: [], cursor: null }
  );
  assert.strictEqual(
    (yield* call("postgres.query", {
      connection: "warehouse",
      sql: "SELECT 1::bigint AS value WHERE false",
      params: [],
      shape: { value: { kind: "integer" } }
    }).pipe(Effect.flip)).code,
    "shape_mismatch"
  );
  return call;
});

it.layer(Layer.mergeAll(Testing.emptyLayer({}), NodeFileSystem.layer, NodePath.layer))(
  "discovered Postgres native/dev parity",
  (it) => {
    it.effect(
      "accepts discovered domain arrays on both surfaces without weakening pinned source drift checks",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("CREATE DOMAIN public.positive AS integer CHECK (VALUE > 0)");
          yield* sql.unsafe(
            'CREATE TABLE public.items (id integer PRIMARY KEY, "values" public.positive[])'
          );
          yield* sql.unsafe("CREATE TABLE public.excluded (location point)");
          yield* sql.unsafe(fixtureSql);
          const snapshot = yield* sql.withTransaction(
            Source.discover.pipe(
              Effect.provideService(SourceClient.SourceClient, {
                query: (statement, parameters = []) =>
                  sql.unsafe(statement, parameters).pipe(
                    Effect.mapError(
                      (cause) =>
                        new SourceClient.SourceUnavailable({
                          stage: "query",
                          cause: Redacted.make(cause)
                        })
                    )
                  )
              })
            )
          );
          const generated = generate(declaration, snapshot);
          assert.include(generated.context, "public.excluded");
          assert.include(generated.context, "unsupported_type");
          const store = yield* ConnectionStore.ConnectionStore.pipe(
            Effect.provide(
              ConnectionStore.layerDev([
                { connection, snapshots: [{ revision: declaration.revision, snapshot }] }
              ])
            )
          );
          const databases = yield* sql<{ database: string }>`SELECT current_database() AS database`;
          const url = new URL(inject("postgres").adminUrl);
          url.pathname = `/${databases[0]!.database}`;
          // Replace only transport acquisition with this isolated cluster, not native execution policy.
          const native = yield* Execution.makeWithClient(
            Effect.fn("test.parity.openNative")(function* () {
              const client = yield* Effect.acquireRelease(
                Effect.sync(() => {
                  const client = new Pg.Client({ connectionString: url.toString() });
                  client.on("error", () => Execution.destroy(client));
                  return client;
                }),
                (client) => Effect.sync(() => Execution.destroy(client))
              );
              yield* Effect.tryPromise({
                try: () => client.connect(),
                catch: (cause) =>
                  new SourceClient.SourceUnavailable({
                    stage: "connect",
                    cause: Redacted.make(cause)
                  })
              });
              return client;
            }),
            (_settings, client) => Effect.sync(() => Execution.destroy(client))
          ).pipe(
            Effect.provideService(ConnectionStore.ConnectionStore, {
              ...store,
              poolCredentials: () =>
                Effect.succeed(Redacted.make("postgres://reader:secret@fixture.example/fixture"))
            })
          );
          const nativeCall = yield* exercise.pipe(
            Effect.provideService(Execution.Execution, native),
            Effect.provideService(ConnectionStore.ConnectionStore, store)
          );
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "postgres-parity-" });
          yield* fs.makeDirectory(`${root}/fixtures`);
          yield* fs.writeFileString(`${root}/fixtures/postgres-warehouse.sql`, fixtureSql);
          yield* exercise.pipe(
            Effect.provide(
              Dev.dev(snapshot, {
                connectionId: declaration.id,
                handle: declaration.handle,
                root
              })
            ),
            Effect.provideService(ConnectionStore.ConnectionStore, store),
            Effect.scoped
          );

          // Retyping the unselected array must fail even when no business row is returned.
          yield* sql.unsafe(
            'ALTER TABLE public.items ALTER COLUMN "values" TYPE bigint[] USING "values"::bigint[]'
          );
          for (const [op, args] of [
            ["postgres.list", request],
            ["postgres.list", { ...request, select: ["id"], eq: { id: 99 } }],
            ["postgres.get", { ...request, key: { id: 99 } }],
            ["postgres.getMany", { ...request, keys: [{ id: 1 }, { id: 99 }] }]
          ] as const) {
            const failure = yield* nativeCall(op, args).pipe(Effect.flip);
            assert.instanceOf(failure, Operations.SourceSchemaChanged);
            if (failure instanceof Operations.SourceSchemaChanged)
              assert.deepStrictEqual(failure.details, {
                relation,
                reason: "source_schema_changed"
              });
          }
          for (const [ddl, raw, sqlstate] of [
            [
              'ALTER TABLE public.items DROP COLUMN "values"',
              'SELECT "values" FROM public.items',
              "42703"
            ],
            ["DROP TABLE public.items", "SELECT id FROM public.items", "42P01"]
          ] as const) {
            yield* sql.unsafe(ddl);
            assert.instanceOf(
              yield* nativeCall("postgres.list", request).pipe(Effect.flip),
              Operations.SourceSchemaChanged
            );
            const failure = yield* nativeCall("postgres.query", {
              connection: "warehouse",
              sql: raw,
              params: [],
              shape: { id: { kind: "integer" } }
            }).pipe(Effect.flip);
            assert.instanceOf(failure, Execution.InvalidQuery);
            if (failure instanceof Execution.InvalidQuery)
              assert.strictEqual(failure.details.sqlstate, sqlstate);
          }
        }).pipe(Effect.scoped),
      30_000
    );
  }
);
