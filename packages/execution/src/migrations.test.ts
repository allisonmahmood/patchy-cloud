import { assert, it } from "@effect/vitest";
import { migrate } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import { migrations } from "./migrations.js";

// The fleet's tables as the release before box sizes left them, in a database of their own.
const beforeBoxSizes = () =>
  Testing.emptyLayer(
    Object.fromEntries(
      Object.entries(migrations).filter(([key]) => key < "0047_execution_box_sizes")
    )
  );

const appliedBoxSizes = [[47, "execution_box_sizes"] as const];

// Whether the rollout row has the switch box sizes add: the step applied or not.
const hasSwitch = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly columns: number }>`SELECT count(*)::integer AS columns
    FROM information_schema.columns
    WHERE table_name = 'execution_rollout' AND column_name = 'small_boxes'`
).pipe(Effect.map((rows) => rows[0]!.columns === 1));

// The backend of a migration asleep between tries for the fleet tables, on the real clock.
const retrying = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const [row] = yield* sql<{ readonly pid: number }>`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'`;
    if (row) return row.pid;
    yield* Effect.sleep(5);
  }
}).pipe(Effect.timeout("5 seconds"), TestClock.withLive);

// The fleet tables a backend holds or waits for a lock on.
const fleetLocks = (pid: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly relname: string }>`SELECT c.relname FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = ${pid}
        AND c.relname IN ('execution_rollout', 'execution_tasks', 'execution_pool_waits')`
  );

// A host of the previous release in the middle of a fleet transaction, taking the tables in its
// own order: it runs `first`, and `then` once `go` is done, and commits.
const hosts = [
  {
    name: "a replacement, which locks the rollout row and then touches the tasks",
    first: `SELECT singleton FROM execution_rollout WHERE singleton FOR SHARE`,
    then: `SELECT task_id FROM execution_tasks WHERE state = 'spare' FOR UPDATE SKIP LOCKED`
  },
  {
    name: "a claim, which touches the tasks and then reads the rollout",
    first: `SELECT task_id FROM execution_tasks WHERE state = 'spare' FOR UPDATE SKIP LOCKED`,
    then: `SELECT current_revision FROM execution_rollout WHERE singleton`
  }
];

for (const host of hosts) {
  it.effect(
    `box sizes wait out ${host.name}, holding no table between tries`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const holding = yield* Deferred.make<void>();
        const go = yield* Deferred.make<void>();
        const transaction = yield* sql
          .withTransaction(
            sql
              .unsafe(host.first)
              .pipe(
                Effect.andThen(Deferred.succeed(holding, undefined)),
                Effect.andThen(Deferred.await(go)),
                Effect.andThen(sql.unsafe(host.then))
              )
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(holding);
        const migration = yield* migrate(migrations).pipe(Effect.forkChild);
        // Asleep between tries, it holds none of the fleet tables, whatever a failed try took, so
        // the host's next statement never waits on it.
        assert.deepStrictEqual(yield* fleetLocks(yield* retrying), []);
        yield* Deferred.succeed(go, undefined);
        yield* Fiber.join(transaction).pipe(Effect.timeout("5 seconds"), TestClock.withLive);
        assert.deepStrictEqual(yield* Fiber.join(migration), appliedBoxSizes);
        assert.isTrue(yield* hasSwitch);
      }).pipe(Effect.provide(beforeBoxSizes())),
    // Past its own five-second waits, so a migration that blocks fails naming the wait.
    15_000
  );
}

it.effect("box sizes check each new launch count, never validating the rows already there", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(yield* migrate(migrations), appliedBoxSizes);
    assert.deepStrictEqual(
      yield* sql`SELECT contype, convalidated FROM pg_constraint
        WHERE conname = 'execution_tasks_unrefused_launches_check'`,
      [{ contype: "c", convalidated: false }]
    );
    yield* sql`INSERT INTO execution_deployments(revision) VALUES ('box-sizes')`;
    const failure = yield* Effect.flip(sql`INSERT INTO execution_tasks
      (task_id, deployment_revision, state, requested_at, unrefused_launches)
      VALUES ('negative', 'box-sizes', 'starting', 0, -1)`);
    assert.strictEqual(failure.reason._tag, "ConstraintError");
    assert.match(String(failure.reason.cause), /execution_tasks_unrefused_launches_check/);
  }).pipe(Effect.provide(beforeBoxSizes()))
);

it.effect(
  "box sizes give up when the fleet tables stay busy, applying nothing, and apply when run again",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const holding = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const transaction = yield* sql
        .withTransaction(
          sql`SELECT singleton FROM execution_rollout WHERE singleton FOR SHARE`.pipe(
            Effect.andThen(Deferred.succeed(holding, undefined)),
            Effect.andThen(Deferred.await(done))
          )
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holding);
      const failure = yield* Effect.flip(migrate(migrations));
      const cause = failure._tag === "MigrationError" ? failure.cause : undefined;
      const reason = SqlError.isSqlError(cause) ? cause.reason : undefined;
      assert.strictEqual(reason?._tag, "LockTimeoutError");
      assert.match(String(reason?.cause), /execution fleet tables stayed busy for 10 seconds/);
      assert.isFalse(yield* hasSwitch);
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(transaction);
      assert.deepStrictEqual(yield* migrate(migrations), appliedBoxSizes);
      assert.isTrue(yield* hasSwitch);
    }).pipe(Effect.provide(beforeBoxSizes())),
  30_000
);
