import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { inject } from "vitest";
import { layerFromUrl } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as QueryRollups from "./QueryRollups.js";
import * as RollupSocketProxy from "./test/rollupSocketProxy.js";

const MINUTE = Date.UTC(2026, 0, 1);
const input = (runId: string, handler: string): QueryRollups.Record => ({
  runId,
  companyId: "cmp_rollups",
  patchId: "patch_rollups",
  versionId: "version_rollups",
  handler,
  startedAt: MINUTE + 12_345,
  reRun: false,
  failures: 0,
  guestMs: 17,
  dbMs: 29,
  callbacks: 3,
  argsBytes: 41,
  resultBytes: 53
});

const databaseUrl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ database: string }>`SELECT current_database() AS database`;
  const url = new URL(inject("postgres").adminUrl);
  url.pathname = `/${rows[0]!.database}`;
  return url.toString();
});

const secondClient = Effect.gen(function* () {
  const url = yield* databaseUrl;
  const context = yield* Layer.build(layerFromUrl(Redacted.make(url)));
  return Context.get(context, SqlClient.SqlClient);
});

const rollupsFromUrl = Effect.fnUntraced(function* (url: string) {
  const context = yield* Layer.build(layerFromUrl(Redacted.make(url)));
  return yield* QueryRollups.make.pipe(
    Effect.provideService(SqlClient.SqlClient, Context.get(context, SqlClient.SqlClient))
  );
});

const totals = Effect.fnUntraced(function* (handler: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`
    SELECT minute, runs, re_runs AS "reRuns", failures, guest_ms AS "guestMs",
      db_ms AS "dbMs", callbacks, args_bytes AS "argsBytes", result_bytes AS "resultBytes"
    FROM runtime_query_rollups
    WHERE company_id = 'cmp_rollups' AND handler = ${handler}
    ORDER BY minute`;
});

it.layer(Testing.layer())("QueryRollups", (it) => {
  it.effect(
    "adds concurrent unique runs once across independent clients and duplicate retries",
    () =>
      Effect.gen(function* () {
        const rollups = yield* QueryRollups.make;
        const runs = Array.from({ length: 24 }, (_, index) => ({
          ...input(`concurrent-${index}`, "concurrent"),
          reRun: index % 3 === 0,
          failures: index % 5 === 0 ? 1 : 0,
          guestMs: index + 1,
          dbMs: (index + 1) * 2,
          callbacks: index % 4,
          argsBytes: index * 3,
          resultBytes: index * 5
        }));
        yield* Effect.gen(function* () {
          const otherSql = yield* secondClient;
          const other = yield* QueryRollups.make.pipe(
            Effect.provideService(SqlClient.SqlClient, otherSql)
          );
          yield* Effect.forEach(
            runs.flatMap((run) => [run, run, run]),
            (run, index) => (index % 2 === 0 ? rollups : other).record(run),
            { concurrency: 12, discard: true }
          );
        }).pipe(Effect.scoped);

        // Recreate the pool and service after commit, as a caller retrying an
        // unacknowledged settlement would. Nothing is deduplicated in memory.
        yield* Effect.gen(function* () {
          const otherSql = yield* secondClient;
          const restarted = yield* QueryRollups.make.pipe(
            Effect.provideService(SqlClient.SqlClient, otherSql)
          );
          yield* Effect.forEach(runs, restarted.record, { concurrency: 8, discard: true });
        }).pipe(Effect.scoped);
        assert.deepStrictEqual(yield* totals("concurrent"), [
          {
            minute: new Date(MINUTE),
            runs: "24",
            reRuns: "8",
            failures: "5",
            guestMs: "300",
            dbMs: "600",
            callbacks: "36",
            argsBytes: "828",
            resultBytes: "1380"
          }
        ]);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT count(*) AS count FROM runtime_query_rollup_runs
          WHERE run_id LIKE 'concurrent-%'`,
          [{ count: "24" }]
        );
      })
  );

  it.effect("uses the start's UTC minute regardless of the database session timezone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rollups = yield* QueryRollups.make;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL TIME ZONE 'Asia/Kathmandu'`;
          yield* rollups.record({
            ...input("minute-before", "minutes"),
            startedAt: MINUTE - 1
          });
          yield* rollups.record({ ...input("minute-at", "minutes"), startedAt: MINUTE });
          yield* rollups.record({
            ...input("minute-end", "minutes"),
            startedAt: MINUTE + 59_999
          });
          yield* rollups.record({
            ...input("minute-next", "minutes"),
            startedAt: MINUTE + 60_000
          });
        })
      );
      assert.deepStrictEqual(yield* totals("minutes"), [
        {
          minute: new Date(MINUTE - 60_000),
          runs: "1",
          reRuns: "0",
          failures: "0",
          guestMs: "17",
          dbMs: "29",
          callbacks: "3",
          argsBytes: "41",
          resultBytes: "53"
        },
        {
          minute: new Date(MINUTE),
          runs: "2",
          reRuns: "0",
          failures: "0",
          guestMs: "34",
          dbMs: "58",
          callbacks: "6",
          argsBytes: "82",
          resultBytes: "106"
        },
        {
          minute: new Date(MINUTE + 60_000),
          runs: "1",
          reRuns: "0",
          failures: "0",
          guestMs: "17",
          dbMs: "29",
          callbacks: "3",
          argsBytes: "41",
          resultBytes: "53"
        }
      ]);
    })
  );

  it.effect(
    "rolls back a dedup id when its rollup increment fails, allowing the same id to retry",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rollups = yield* QueryRollups.make;
        const run = input("failed-increment", "failed-increment");
        const error = yield* rollups.record({ ...run, guestMs: -1 }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SqlError");
        assert.deepStrictEqual(yield* totals(run.handler), []);
        assert.deepStrictEqual(
          yield* sql`SELECT run_id FROM runtime_query_rollup_runs WHERE run_id = ${run.runId}`,
          []
        );
        yield* rollups.record(run);
        yield* rollups.record(run);
        assert.deepStrictEqual(yield* totals(run.handler), [
          {
            minute: new Date(MINUTE),
            runs: "1",
            reRuns: "0",
            failures: "0",
            guestMs: "17",
            dbMs: "29",
            callbacks: "3",
            argsBytes: "41",
            resultBytes: "53"
          }
        ]);
      })
  );

  it.effect(
    "commits the dedup id and increment only with the surrounding platform transaction",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rollups = yield* QueryRollups.make;
        const run = input("rolled-back", "rolled-back");
        const error = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* rollups.record(run);
              return yield* Effect.fail("rollback");
            })
          )
          .pipe(Effect.flip);
        assert.strictEqual(error, "rollback");
        assert.deepStrictEqual(yield* totals(run.handler), []);
        assert.deepStrictEqual(
          yield* sql`SELECT run_id FROM runtime_query_rollup_runs WHERE run_id = ${run.runId}`,
          []
        );
        yield* rollups.record(run);
        assert.deepStrictEqual(
          yield* sql`SELECT runs, db_ms FROM runtime_query_rollups WHERE handler = ${run.handler}`,
          [{ runs: "1", db_ms: "29" }]
        );
        assert.deepStrictEqual(
          yield* sql`SELECT run_id FROM runtime_query_rollup_runs WHERE run_id = ${run.runId}`,
          [{ run_id: run.runId }]
        );
      })
  );

  it.effect("prunes hour-old dedup ids without pruning counters or recent retry protection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rollups = yield* QueryRollups.make;
      const expired = input("retention-expired", "retention");
      const retained = input("retention-retained", "retention");
      const fresh = input("retention-fresh", "retention");
      yield* rollups.record(expired);
      yield* rollups.record(retained);
      yield* sql`UPDATE runtime_query_rollup_runs
        SET applied_at = statement_timestamp() - INTERVAL '61 minutes'
        WHERE run_id = ${expired.runId}`;
      yield* sql`UPDATE runtime_query_rollup_runs
        SET applied_at = statement_timestamp() - INTERVAL '59 minutes'
        WHERE run_id = ${retained.runId}`;
      yield* rollups.record(fresh);
      yield* rollups.record(retained);
      yield* rollups.record(fresh);
      assert.deepStrictEqual(
        yield* sql`SELECT run_id FROM runtime_query_rollup_runs
          WHERE run_id LIKE 'retention-%' ORDER BY run_id`,
        [{ run_id: fresh.runId }, { run_id: retained.runId }]
      );
      assert.deepStrictEqual(yield* totals("retention"), [
        {
          minute: new Date(MINUTE),
          runs: "3",
          reRuns: "0",
          failures: "0",
          guestMs: "51",
          dbMs: "87",
          callbacks: "9",
          argsBytes: "123",
          resultBytes: "159"
        }
      ]);
    })
  );
  for (const fault of ["before-statement", "after-commit"] as const) {
    it.effect(`settles once after a real PostgreSQL socket loss ${fault}`, () =>
      Effect.gen(function* () {
        const run = input(`socket-${fault}`, `socket-${fault}`);
        const proxy = yield* RollupSocketProxy.make(yield* databaseUrl, fault);
        const rollups = yield* rollupsFromUrl(proxy.url);
        const logs: unknown[] = [];
        const settling = yield* rollups
          .settle(run)
          .pipe(
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
            Effect.provide(Logger.layer([Logger.make((event) => logs.push(event.message))])),
            Effect.forkChild
          );
        assert.strictEqual(yield* proxy.reached, fault === "after-commit" ? "I" : "not-sent");
        yield* Fiber.join(settling);
        assert.deepStrictEqual(logs, []);
        yield* rollups.settle(run);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT runs, guest_ms, db_ms FROM runtime_query_rollups
            WHERE handler = ${run.handler}`,
          [{ runs: "1", guest_ms: "17", db_ms: "29" }]
        );
        assert.deepStrictEqual(
          yield* sql`SELECT run_id FROM runtime_query_rollup_runs WHERE run_id = ${run.runId}`,
          [{ run_id: run.runId }]
        );
      }).pipe(Effect.scoped)
    );
  }

  it.effect("keeps an acknowledged increment when the separate pruning connection drops", () =>
    Effect.gen(function* () {
      const run = input("socket-prune", "socket-prune");
      const proxy = yield* RollupSocketProxy.make(yield* databaseUrl, "before-prune");
      const logs: unknown[] = [];
      const rollups = yield* rollupsFromUrl(proxy.url);
      yield* rollups
        .settle(run)
        .pipe(Effect.provide(Logger.layer([Logger.make((event) => logs.push(event.message))])));
      assert.strictEqual(yield* proxy.reached, "not-sent");
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT runs, guest_ms FROM runtime_query_rollups WHERE handler = ${run.handler}`,
        [{ runs: "1", guest_ms: "17" }]
      );
      assert.deepStrictEqual(logs, [
        ["Query rollup dedup pruning failed", { reason: "ConnectionError" }]
      ]);
      yield* rollups.settle(run);
      assert.deepStrictEqual(
        yield* sql`SELECT runs FROM runtime_query_rollups WHERE handler = ${run.handler}`,
        [{ runs: "1" }]
      );
    }).pipe(Effect.scoped)
  );
});

const failingSql = (acquirer: Effect.Effect<never, SqlError.SqlError>) =>
  Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({ acquirer, compiler: PgClient.makeCompiler(), spanAttributes: [] })
  ).pipe(Layer.provide(Reactivity.layer));

it.effect("backs off with jitter and stops retrying within the dedup retention window", () =>
  Effect.gen(function* () {
    const attempts: number[] = [];
    const logs: unknown[] = [];
    const unavailable = new SqlError.SqlError({
      reason: new SqlError.ConnectionError({ cause: new Error("postgres://secret@private") })
    });
    const start = yield* Clock.currentTimeMillis;
    const layer = failingSql(
      Effect.gen(function* () {
        attempts.push((yield* Clock.currentTimeMillis) - start);
        return yield* Effect.fail(unavailable);
      })
    );
    const rollups = yield* QueryRollups.make.pipe(Effect.provide(layer));
    let done = false;
    const settlement = yield* rollups.settle(input("outage", "outage")).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          done = true;
        })
      ),
      Random.withSeed("rollup-retry"),
      Effect.provide(Logger.layer([Logger.make((event) => logs.push(event.message))])),
      Effect.forkChild
    );
    yield* TestClock.adjust("299999 millis");
    assert.isFalse(done);
    assert.isAtLeast(attempts.length, 25);
    assert.isAtMost(attempts.length, 50);
    assert.strictEqual(attempts[0], 0);
    const gaps = attempts.slice(1).map((time, index) => time - attempts[index]!);
    assert.isAtLeast(gaps[0]!, 80);
    assert.isAtMost(gaps[0]!, 120);
    for (let index = 0; index < gaps.length; index++) {
      assert.isAtLeast(gaps[index]!, Math.min(100 * 2 ** index, 10_000) * 0.8 - 1);
      assert.isAtMost(gaps[index]!, Math.min(100 * 2 ** index * 1.2, 10_000) + 1);
    }
    assert.isAbove(new Set(gaps.slice(-10)).size, 1);
    yield* TestClock.adjust(1);
    yield* Fiber.join(settlement);
    assert.isTrue(done);
    assert.deepStrictEqual(logs, [
      ["Query rollup settlement dropped", { reason: "retry_budget_exhausted" }]
    ]);
    const stopped = [...attempts];
    yield* TestClock.adjust("2 hours");
    assert.deepStrictEqual(attempts, stopped);
  })
);

it.effect("includes a stalled SQL acquisition in the total settlement budget", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let interrupted = false;
    const logs: unknown[] = [];
    const layer = failingSql(
      Effect.suspend(() => {
        attempts++;
        return Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            })
          )
        );
      })
    );
    const rollups = yield* QueryRollups.make.pipe(Effect.provide(layer));
    const settlement = yield* rollups
      .settle(input("stalled", "stalled"))
      .pipe(
        Effect.provide(Logger.layer([Logger.make((event) => logs.push(event.message))])),
        Effect.forkChild
      );
    yield* TestClock.adjust("5 minutes");
    yield* Fiber.join(settlement);
    assert.strictEqual(attempts, 1);
    assert.isTrue(interrupted);
    assert.deepStrictEqual(logs, [
      ["Query rollup settlement dropped", { reason: "retry_budget_exhausted" }]
    ]);
  })
);

for (const Reason of [
  SqlError.AuthenticationError,
  SqlError.AuthorizationError,
  SqlError.ConstraintError,
  SqlError.SqlSyntaxError,
  SqlError.UnknownError
]) {
  it.effect(`drops ${Reason.name} without retrying or logging the raw SQL failure`, () =>
    Effect.gen(function* () {
      const error = new SqlError.SqlError({
        reason: new Reason({ cause: new Error("postgres://secret@private"), message: "secret SQL" })
      });
      let attempts = 0;
      const logs: unknown[] = [];
      const rollups = yield* QueryRollups.make.pipe(
        Effect.provide(
          failingSql(
            Effect.suspend(() => {
              attempts++;
              return Effect.fail(error);
            })
          )
        )
      );
      yield* rollups
        .settle(input("permanent", "permanent"))
        .pipe(Effect.provide(Logger.layer([Logger.make((event) => logs.push(event.message))])));
      assert.strictEqual(attempts, 1);
      assert.deepStrictEqual(logs, [
        ["Query rollup settlement dropped", { reason: error.reason._tag }]
      ]);
    })
  );
}

it.effect("does not swallow defects as best-effort SQL failures", () =>
  Effect.gen(function* () {
    const defect = new Error("programming defect");
    const rollups = yield* QueryRollups.make.pipe(Effect.provide(failingSql(Effect.die(defect))));
    const result = yield* rollups.settle(input("defect", "defect")).pipe(Effect.exit);
    assert.isTrue(Exit.hasDies(result));
  })
);
