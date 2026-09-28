import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Testing from "@patchy/sql/testing";
import * as WakesPostgres from "./WakesPostgres.js";

it.layer(Testing.layer())("cross-host wakes", (it) => {
  it.effect("delivers committed resource keys and write linkage to another replica", () =>
    Effect.gen(function* () {
      const hostA = yield* WakesPostgres.make;
      const hostB = yield* WakesPostgres.make;
      const received = yield* Queue.unbounded<{
        keys: readonly string[];
        cause: string | undefined;
      }>();
      yield* hostB.subscribe((keys, cause) =>
        Queue.offer(received, { keys, cause }).pipe(Effect.asVoid)
      );
      // Reconciliation signals that LISTEN was acknowledged before the write.
      assert.deepStrictEqual((yield* Queue.take(received)).keys, []);
      yield* hostA.publish(["table:source:rows", "patch:source"], "write-event");
      const wake = yield* Queue.take(received);
      assert.deepStrictEqual(wake, {
        keys: ["table:source:rows", "patch:source"],
        cause: "write-event"
      });
      const keys = Array.from(
        { length: 100 },
        (_, index) => `table:source:${String(index)}_${"x".repeat(100)}`
      );
      yield* hostA.publish(keys);
      const delivered: string[] = [];
      while (delivered.length < keys.length) delivered.push(...(yield* Queue.take(received)).keys);
      assert.deepStrictEqual(delivered, keys);
    }).pipe(Effect.scoped)
  );

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
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Queue.take(received), []);
      yield* host.publish(["store:source:files"]);
      assert.deepStrictEqual(yield* Queue.take(received), ["store:source:files"]);
    }).pipe(Effect.scoped)
  );
});
