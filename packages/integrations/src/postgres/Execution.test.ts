// @effect-diagnostics nodeBuiltinImport:off -- Only the isolated native transport bypasses production TLS admission.
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Testing from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Pg from "pg";
import { inject } from "vitest";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Execution from "./Execution.js";
import * as SourceClient from "./SourceClient.js";

const connection = new ConnectionStore.Connection({
  id: "conn-execution",
  companyId: "company-execution",
  integration: "postgres",
  handle: "warehouse",
  description: "Isolated native execution",
  mode: "company",
  status: "connected",
  display: { host: "warehouse.example", port: 5432, database: "warehouse", role: "reader1" },
  credentialRevision: 1,
  metadataRevision: 1,
  lastTestedAt: null,
  lastDiscoveredAt: null,
  createdBy: "tester"
});
const declaration = {
  kind: "postgres" as const,
  id: connection.id,
  handle: connection.handle,
  revision: 1
};
const input = (text: string): Execution.QueryInput => ({
  companyId: connection.companyId,
  declaration,
  text,
  parameters: []
});

/** Only socket acquisition is replaced: every query still uses a real native pg backend. */
const setup = Effect.fn("test.executionSetup")(function* (config: Record<string, number> = {}) {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ database: string }>`SELECT current_database() AS database`;
  const database = databases[0]!.database;
  const url = new URL(inject("postgres").adminUrl);
  url.pathname = `/${database}`;
  const rolePrefix = `execution_${randomUUID().replaceAll("-", "")}`;
  for (const revision of [1, 2]) {
    yield* sql.unsafe(`CREATE ROLE "${rolePrefix}_${revision}" LOGIN PASSWORD 'secret'`);
    yield* sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${rolePrefix}_${revision}"`);
    yield* sql.unsafe(
      `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO "${rolePrefix}_${revision}"`
    );
  }
  yield* Effect.addFinalizer(() =>
    sql
      .unsafe(`DROP OWNED BY "${rolePrefix}_1", "${rolePrefix}_2"`)
      .pipe(
        Effect.andThen(sql.unsafe(`DROP ROLE "${rolePrefix}_1", "${rolePrefix}_2"`)),
        Effect.orDie
      )
  );
  const clients: Array<Pg.Client> = [];
  const roles: Array<string> = [];
  const cancellations: Array<number> = [];
  let current = connection;
  let onCheck: Effect.Effect<void> = Effect.void;
  let beforeCredentials: Effect.Effect<void> = Effect.void;
  const scope = yield* Scope.Scope;
  const execution = yield* Effect.gen(function* () {
    const metadata = yield* ConnectionStore.ConnectionStore;
    return yield* Execution.makeWithClient(
      Effect.fn("test.openNative")(function* (settings) {
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const authenticated = new URL(url);
            authenticated.username = settings.role;
            authenticated.password = Redacted.value(settings.password);
            const client = new Pg.Client({
              connectionString: authenticated.toString(),
              application_name: "patchy-execution-test"
            });
            client.on("error", () => {});
            clients.push(client);
            roles.push(settings.role);
            return client;
          }),
          (client) => Effect.sync(() => Execution.destroy(client))
        );
        yield* Effect.tryPromise({
          try: () => client.connect(),
          catch: (cause) =>
            new SourceClient.SourceUnavailable({ stage: "connect", cause: Redacted.make(cause) })
        });
        return client;
      }),
      (_settings, client) =>
        Effect.callback<void, SourceClient.SourceError>((resume) => {
          const key = client as Pg.Client & { processID: number; secretKey: number };
          const request = Buffer.alloc(16);
          request.writeInt32BE(16, 0);
          request.writeInt32BE(80877102, 4);
          request.writeInt32BE(key.processID, 8);
          request.writeInt32BE(key.secretKey, 12);
          const socket = new Socket();
          socket.on("error", (cause) =>
            resume(
              Effect.fail(
                new SourceClient.SourceUnavailable({
                  stage: "connect",
                  cause: Redacted.make(cause)
                })
              )
            )
          );
          socket.once("connect", () => {
            socket.write(request);
          });
          socket.once("end", () => {
            cancellations.push(key.processID);
            resume(Effect.void);
          });
          socket.connect(Number(url.port), url.hostname);
          return Effect.sync(() => {
            socket.destroy();
          });
        })
    ).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(ConnectionStore.ConnectionStore, {
        ...metadata,
        get: () => onCheck.pipe(Effect.andThen(Effect.sync(() => current))),
        poolCredentials: (_companyId, _declaration, revision) =>
          beforeCredentials.pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (current.status !== "connected")
                  return Effect.fail(new ConnectionStore.ConnectionNotConnected({}));
                if (revision !== current.credentialRevision)
                  return Effect.fail(new ConnectionStore.ConnectionChanged({}));
                return Effect.succeed(
                  Redacted.make(
                    `postgres://${rolePrefix}_${revision}:secret@warehouse.example/warehouse`
                  )
                );
              })
            )
          )
      })
    );
  }).pipe(
    Effect.provide(
      ConnectionStore.layerDev([
        {
          connection,
          snapshots: [
            { revision: 1, snapshot: { version: 1, relations: [], enums: [], exclusions: [] } }
          ]
        }
      ])
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config)))
  );
  return {
    execution,
    clients,
    roles,
    cancellations,
    rolePrefix,
    change: (changes: Partial<ConnectionStore.Connection>) => {
      current = new ConnectionStore.Connection({ ...current, ...changes });
    },
    watch: (effect: Effect.Effect<void>) => {
      onCheck = effect;
    },
    holdCredentials: (effect: Effect.Effect<void>) => {
      beforeCredentials = effect;
    }
  };
});
const sleeping = Effect.fn("test.awaitSleeping")(function* (count: number) {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const rows = yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'patchy-execution-test' AND wait_event = 'PgSleep'`;
    if (rows[0]!.count >= count) return;
    yield* Effect.yieldNow;
  }
});

it.layer(Testing.emptyLayer({}))("native PostgreSQL execution", (it) => {
  it.effect(
    "denies INSERT, a side-effect function and multiple statements in native read-only transactions",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE TABLE execution_writes (value int)");
        yield* sql.unsafe(
          "CREATE FUNCTION execution_write() RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO execution_writes VALUES (1); RETURN 1; END $$"
        );
        const { execution } = yield* setup();
        for (const text of [
          "INSERT INTO execution_writes VALUES (2)",
          "SELECT execution_write()"
        ]) {
          const error = yield* execution.query(input(text)).pipe(Effect.flip);
          assert.instanceOf(error, Execution.InvalidQuery);
          if (error._tag === "InvalidQuery") assert.strictEqual(error.details.sqlstate, "25006");
        }
        const multiple = yield* execution
          .query(input("SELECT 1; INSERT INTO execution_writes VALUES (3)"))
          .pipe(Effect.flip);
        assert.instanceOf(multiple, Execution.InvalidQuery);
        if (multiple._tag === "InvalidQuery")
          assert.strictEqual(multiple.details.sqlstate, "42601");
        assert.deepStrictEqual(yield* sql.unsafe("SELECT value FROM execution_writes"), []);
      })
  );

  it.effect(
    "resets sessions before reuse and preserves duplicate fields, empty results and native precision",
    () =>
      Effect.gen(function* () {
        const { execution, clients } = yield* setup();
        const first = yield* execution.query(
          input("SELECT pg_backend_pid(), set_config('search_path', 'pg_catalog', false)")
        );
        const next = yield* execution.query(
          input(
            "SELECT pg_backend_pid(), current_setting('search_path'), current_setting('statement_timeout')"
          )
        );
        assert.strictEqual(next.rows[0]![0], first.rows[0]![0]);
        assert.strictEqual(next.rows[0]![1], '"$user", public');
        assert.strictEqual(next.rows[0]![2], "10s");
        const empty = yield* execution.query(
          input("SELECT 1 AS duplicate, 2 AS duplicate WHERE false")
        );
        assert.deepStrictEqual(
          empty.fields.map((field) => field.name),
          ["duplicate", "duplicate"]
        );
        assert.deepStrictEqual(empty.rows, []);
        const duplicates = yield* execution.query(input("SELECT 1 AS duplicate, 2 AS duplicate"));
        assert.deepStrictEqual(duplicates.rows, [[1, 2]]);
        const precise = yield* execution.query(
          input(
            "SELECT 9223372036854775807::bigint, 1234567890.1234567890123456789::numeric, '2026-09-10'::date, '2026-09-10 12:13:14.123456'::timestamp, '2026-09-10 12:13:14.123456+00'::timestamptz"
          )
        );
        assert.deepStrictEqual(precise.rows[0]!.slice(0, 4), [
          "9223372036854775807",
          "1234567890.1234567890123456789",
          "2026-09-10",
          "2026-09-10 12:13:14.123456"
        ]);
        assert.include(String(precise.rows[0]![4]), ".123456");
        const arrays = yield* execution.query(
          input(
            "SELECT ARRAY[1234567890.1234567890123456789::numeric], ARRAY['2026-09-10 12:13:14.123456'::timestamp]"
          )
        );
        assert.deepStrictEqual(arrays.rows, [
          [["1234567890.1234567890123456789"], ["2026-09-10 12:13:14.123456"]]
        ]);
        yield* TestClock.adjust("60 seconds");
        assert.isTrue(clients[0]!.connection.stream.destroyed);
        const replacement = yield* execution.query(input("SELECT pg_backend_pid()"));
        assert.notStrictEqual(replacement.rows[0]![0], first.rows[0]![0]);
      })
  );

  it.effect(
    "destroys a backend on server statement timeout and on the queue-inclusive service deadline",
    () =>
      Effect.gen(function* () {
        const short = yield* setup({ PATCHY_POSTGRES_STATEMENT_MS: 30 });
        const timeout = yield* short.execution.query(input("SELECT pg_sleep(1)")).pipe(Effect.flip);
        assert.instanceOf(timeout, Execution.Timeout);
        assert.isTrue(short.clients[0]!.connection.stream.destroyed);
        const deadline = yield* setup({
          PATCHY_POSTGRES_STATEMENT_MS: 100_000,
          PATCHY_POSTGRES_MAX_PER_CONNECTION: 1
        });
        const running = yield* deadline.execution
          .query(input("SELECT pg_sleep(30)"))
          .pipe(Effect.flip, Effect.forkChild);
        yield* sleeping(1);
        const checked = yield* Deferred.make<void>();
        deadline.watch(Deferred.succeed(checked, undefined).pipe(Effect.asVoid));
        const queued = yield* deadline.execution
          .query(input("SELECT 1"))
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(checked);
        yield* TestClock.adjust("15 seconds");
        assert.instanceOf(yield* Fiber.join(running), Execution.Timeout);
        assert.instanceOf(yield* Fiber.join(queued), Execution.Timeout);
        for (const client of deadline.clients) assert.isTrue(client.connection.stream.destroyed);
        const sql = yield* SqlClient.SqlClient;
        while (true) {
          const rows = yield* sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'patchy-execution-test' AND wait_event = 'PgSleep'`;
          if (rows[0]!.count === 0 && deadline.cancellations.length >= 1) break;
          yield* Effect.yieldNow;
        }
      })
  );

  it.effect(
    "does not propagate one cancelled pool initializer's interruption to another caller",
    () =>
      Effect.gen(function* () {
        const state = yield* setup();
        const entered = yield* Deferred.make<void>();
        state.holdCredentials(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        );
        const first = yield* state.execution
          .query(input("SELECT current_user"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const checked = yield* Deferred.make<void>();
        state.watch(Deferred.succeed(checked, undefined).pipe(Effect.asVoid));
        const next = yield* state.execution
          .query(input("SELECT current_user"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(checked);
        yield* TestClock.adjust(1);
        state.holdCredentials(Effect.void);
        yield* Fiber.interrupt(first);
        assert.deepStrictEqual((yield* Fiber.join(next)).rows, [[`${state.rolePrefix}_1`]]);
      })
  );

  it.effect(
    "uses the live credential after waiting without exceeding four backends across revisions",
    () =>
      Effect.gen(function* () {
        const state = yield* setup({ PATCHY_POSTGRES_STATEMENT_MS: 100_000 });
        const running = yield* Effect.forEach([1, 2, 3, 4], () =>
          state.execution.query(input("SELECT pg_sleep(30)")).pipe(Effect.forkChild)
        );
        yield* sleeping(4);
        const checked = yield* Deferred.make<void>();
        state.watch(Deferred.succeed(checked, undefined).pipe(Effect.asVoid));
        const queued = yield* state.execution
          .query(input("SELECT current_user"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(checked);
        assert.strictEqual(state.clients.length, 4);
        state.change({ credentialRevision: 2, metadataRevision: 2 });
        yield* Fiber.interrupt(running[0]!);
        assert.deepStrictEqual((yield* Fiber.join(queued)).rows, [[`${state.rolePrefix}_2`]]);
        assert.deepStrictEqual(
          state.roles,
          [1, 1, 1, 1, 2].map((revision) => `${state.rolePrefix}_${revision}`)
        );
        assert.strictEqual(
          state.clients.filter((client) => !client.connection.stream.destroyed).length,
          4
        );
        yield* Fiber.interruptAll(running);
        state.change({ status: "disconnected", credentialRevision: 3 });
        assert.instanceOf(
          yield* state.execution.query(input("SELECT 43")).pipe(Effect.flip),
          Execution.AccessDenied
        );
        state.change({ status: "connected" });
        const rejectedLogin = yield* state.execution.query(input("SELECT 44")).pipe(Effect.flip);
        assert.instanceOf(rejectedLogin, Execution.SourceUnavailable);
        assert.notInclude(JSON.stringify(rejectedLogin), state.rolePrefix);
        assert.notInclude(JSON.stringify(rejectedLogin), "secret");
      })
  );

  it.effect("counts the process backend budget across different connections", () =>
    Effect.gen(function* () {
      const state = yield* setup({
        PATCHY_POSTGRES_MAX_BACKENDS: 2,
        PATCHY_POSTGRES_STATEMENT_MS: 100_000
      });
      const first = yield* state.execution
        .query(input("SELECT pg_sleep(30)"))
        .pipe(Effect.forkChild);
      yield* sleeping(1);
      state.change({ id: "conn-second" });
      const second = yield* state.execution
        .query({
          ...input("SELECT pg_sleep(30)"),
          declaration: { ...declaration, id: "conn-second" }
        })
        .pipe(Effect.forkChild);
      yield* sleeping(2);
      state.change({ id: "conn-third" });
      const checked = yield* Deferred.make<void>();
      state.watch(Deferred.succeed(checked, undefined).pipe(Effect.asVoid));
      const queued = yield* state.execution
        .query({
          ...input("SELECT current_user"),
          declaration: { ...declaration, id: "conn-third" }
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(checked);
      assert.strictEqual(state.clients.length, 2);
      yield* Fiber.interrupt(first);
      assert.deepStrictEqual((yield* Fiber.join(queued)).rows, [[`${state.rolePrefix}_1`]]);
      assert.strictEqual(
        state.clients.filter((client) => !client.connection.stream.destroyed).length,
        2
      );
      yield* Fiber.interrupt(second);
    })
  );

  it.effect(
    "fails while collecting beyond 1000 rows or eight MiB, never returning a partial result",
    () =>
      Effect.gen(function* () {
        const { execution, clients } = yield* setup();
        const boundary = yield* execution.query(input("SELECT i FROM generate_series(1, 1000) i"));
        assert.strictEqual(boundary.rows.length, 1000);
        const rows = yield* execution
          .query(input("SELECT i, repeat('x', 1000) FROM generate_series(1, 1001) i"))
          .pipe(Effect.flip);
        assert.instanceOf(rows, Execution.TooLarge);
        if (rows._tag === "TooLarge") assert.strictEqual(rows.bound, "rows");
        assert.isTrue(clients[0]!.connection.stream.destroyed);
        const bytes = yield* execution
          .query(input("SELECT repeat('x', 8388609)"))
          .pipe(Effect.flip);
        assert.instanceOf(bytes, Execution.TooLarge);
        if (bytes._tag === "TooLarge") assert.strictEqual(bytes.bound, "bytes");
        assert.isTrue(clients[1]!.connection.stream.destroyed);
        assert.deepStrictEqual((yield* execution.query(input("SELECT 7"))).rows, [[7]]);
      })
  );
});
