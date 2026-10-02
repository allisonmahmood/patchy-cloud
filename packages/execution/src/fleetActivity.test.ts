import { assert, it } from "@effect/vitest";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as FleetActivity from "./fleetActivity.js";

const owner = Effect.fn(function* (key: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ pid: number }>`SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND mode = 'ShareLock' AND granted
      AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows[0]?.pid;
});
const available = Effect.fn(function* (key: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.withTransaction(sql<{ available: boolean }>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS available`);
  return rows[0]!.available;
});

it.layer(Testing.layer())("fleet activity session recovery", (it) => {
  it.effect("restores all live locks on a new admission and preserves reference counts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const activity = yield* FleetActivity.make({ checkInterval: 1_000 });
      const company = "activity-recovery-company";
      const binding = "activity-recovery-binding";
      const first = yield* activity.hold(company);
      const second = yield* activity.hold(company);
      const admitted = yield* activity.hold(binding);
      const before = yield* owner(company);
      assert.isNumber(before);
      yield* sql`SELECT pg_terminate_backend(${before!})`;

      const next = yield* activity.hold("activity-recovery-new-document");
      assert.notStrictEqual(yield* owner(company), before);
      assert.isFalse(yield* available(company));
      assert.isFalse(yield* available(binding));
      yield* first;
      yield* first;
      assert.isFalse(yield* available(company));
      yield* second;
      assert.isTrue(yield* available(company));
      assert.isFalse(yield* available(binding));
      yield* admitted;
      assert.isTrue(yield* available(binding));
      yield* next;
      assert.isTrue(yield* available("activity-recovery-new-document"));
    }).pipe(Effect.scoped)
  );

  it.effect("restores connected-document locks without another request after a session dies", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const activity = yield* FleetActivity.make({ checkInterval: 1_000 });
      const key = "activity-recovery-idle-document";
      const release = yield* activity.hold(key);
      const before = yield* owner(key);
      assert.isNumber(before);
      yield* sql`SELECT pg_terminate_backend(${before!})`;
      yield* TestClock.adjust(1_000);
      const after = yield* owner(key).pipe(
        Effect.repeat({ while: (pid) => pid === undefined || pid === before, times: 100 })
      );
      assert.isNumber(after);
      assert.notStrictEqual(after, before);
      assert.isFalse(yield* available(key));
      yield* release;
      assert.isTrue(yield* available(key));
    }).pipe(Effect.scoped)
  );
});
