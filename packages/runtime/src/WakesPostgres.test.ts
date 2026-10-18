import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Testing from "@patchy/sql/testing";
import * as WakesPostgres from "./WakesPostgres.js";

// A host with one subscriber that records each wake it receives.
const host = Effect.gen(function* () {
  const wakes = yield* WakesPostgres.make;
  const received = yield* Queue.unbounded<{ keys: readonly string[]; cause: string | undefined }>();
  yield* wakes.subscribe((keys, cause) =>
    Queue.offer(received, { keys, cause }).pipe(Effect.asVoid)
  );
  return { wakes, received };
});

it.layer(Testing.layer())("cross-host wakes", (it) => {
  it.effect("wakes the writing host once and every other host once", () =>
    Effect.gen(function* () {
      const pg = yield* PgClient.PgClient;
      const hostA = yield* host;
      const hostB = yield* host;
      // Reconciliation signals that each LISTEN was acknowledged before the write.
      for (const { received } of [hostA, hostB])
        assert.deepStrictEqual((yield* Queue.take(received)).keys, []);
      yield* hostA.wakes.publish(["table:source:rows", "patch:source"], "write-event");
      // An older host's payload carries no origin, like the directory trigger's, so every
      // host takes it. Postgres delivers in commit order, so any echo would arrive first.
      yield* pg.notify("patchy_runtime_wakes", '{"keys":["members:company"]}');
      for (const { received } of [hostA, hostB]) {
        assert.deepStrictEqual(yield* Queue.take(received), {
          keys: ["table:source:rows", "patch:source"],
          cause: "write-event"
        });
        assert.deepStrictEqual(yield* Queue.take(received), {
          keys: ["members:company"],
          cause: undefined
        });
      }
    }).pipe(Effect.scoped)
  );

  it.effect("splits another host's wake below NOTIFY's 8,000-byte payload limit", () =>
    Effect.gen(function* () {
      const hostA = yield* WakesPostgres.make;
      const hostB = yield* host;
      assert.deepStrictEqual((yield* Queue.take(hostB.received)).keys, []);
      const keys = Array.from(
        { length: 100 },
        (_, index) => `table:source:${String(index)}_${"x".repeat(100)}`
      );
      yield* hostA.publish(keys);
      const delivered: string[] = [];
      while (delivered.length < keys.length)
        delivered.push(...(yield* Queue.take(hostB.received)).keys);
      assert.deepStrictEqual(delivered, keys);
    }).pipe(Effect.scoped)
  );

  // A real socket can report its disconnect after a one-off test-clock advance.
  it.effect("requests durable reconciliation after a dropped listener reconnects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const host = yield* WakesPostgres.make;
      const received = yield* Queue.unbounded<readonly string[]>();
      yield* host.subscribe((keys) => Queue.offer(received, keys).pipe(Effect.asVoid));
      assert.deepStrictEqual(yield* Queue.take(received), []);
      yield* sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND query ILIKE 'LISTEN%patchy_runtime_wakes%'`;
      assert.deepStrictEqual(yield* Queue.take(received), []);
      yield* host.publish(["store:source:files"]);
      assert.deepStrictEqual(yield* Queue.take(received), ["store:source:files"]);
    }).pipe(Effect.scoped, TestClock.withLive)
  );
});
