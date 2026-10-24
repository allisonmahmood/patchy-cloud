import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as SetupLinks from "./SetupLinks.js";
import { DEV_SEED } from "./seed.js";

const events: Analytics.AnalyticsEvent[] = [];
const recording = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);
const layer = Layer.mergeAll(MachineTokens.layer, Users.layer, recording).pipe(
  Layer.provideMerge(Testing.layer())
);
const withDeviceLogins = Effect.provide(DeviceLogins.layer.pipe(Layer.provide(Limits.layer)));

const addUser = Effect.fn("SetupLinks.test.addUser")(function* (suffix: string) {
  const sql = yield* SqlClient.SqlClient;
  const id = `usr_setup_${suffix}`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${id}, ${`user_setup_${suffix}`}, ${DEV_SEED.companyId},
      ${`${suffix}@setup.test`}, ${suffix}, 'member')`;
  return id;
});
/** Until another transaction on this database is waiting for a lock. */
const someoneWaits = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let attempt = 0; attempt < 2_000; attempt++) {
    yield* sql`SELECT pg_stat_clear_snapshot()`;
    const waiting = yield* sql`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting.length > 0) return;
  }
  return yield* Effect.die(new Error("nothing waited for the lock"));
});
const outcome = (userId: string) =>
  SetupLinks.status(userId).pipe(Effect.map(Option.map((status) => status.outcome)));
/** A login started from `value`, confirmed by `confirmer`, then collected by its poll. */
const connect = Effect.fn("SetupLinks.test.connect")(function* (value: string, confirmer: string) {
  const logins = yield* DeviceLogins.DeviceLogins;
  const login = yield* logins.start({ machineNameHint: "laptop", setupLink: value });
  yield* logins.confirm({ userCode: login.userCode, userId: confirmer, machineName: "Laptop" });
  return yield* logins.poll(login.deviceCode);
});

it.layer(layer)("SetupLinks", (it) => {
  it.effect(
    "keeps one live line per person, stamps its pickup once, and retires it for a new one",
    () =>
      Effect.gen(function* () {
        const userId = yield* addUser("line");
        const first = yield* SetupLinks.current(userId);
        assert.isTrue(first.created);
        assert.match(first.value, /^[a-z2-7]{26}$/);
        assert.notStrictEqual(first.setupId, first.value);
        const again = yield* SetupLinks.current(userId);
        assert.deepStrictEqual([again.created, again.value], [false, first.value]);
        assert.isNull(SetupLinks.parse("not-a-line"));
        assert.isNull(SetupLinks.parse(`${first.value}x`));

        const picked = yield* SetupLinks.pickUp(first.value);
        assert.isTrue(Option.isSome(picked) && picked.value.first);
        assert.strictEqual(Option.getOrThrow(picked).setupId, first.setupId);
        assert.isFalse(Option.getOrThrow(yield* SetupLinks.pickUp(first.value)).first);

        yield* SetupLinks.retire(userId);
        assert.isTrue(Option.isNone(yield* SetupLinks.pickUp(first.value)));
        const next = yield* SetupLinks.current(userId);
        assert.isTrue(next.created);
        assert.notStrictEqual(next.value, first.value);
      })
  );

  it.effect("binds the first login a line starts and marks a second one contested", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("bind");
      const line = yield* SetupLinks.current(userId);
      const logins = yield* DeviceLogins.DeviceLogins;
      const first = yield* logins.start({ machineNameHint: "laptop", setupLink: line.value });
      assert.deepStrictEqual(yield* outcome(userId), Option.some("pending"));
      const second = yield* logins.start({ machineNameHint: "elsewhere", setupLink: line.value });
      assert.deepStrictEqual(yield* outcome(userId), Option.some("contested"));
      const bound = yield* sql`SELECT user_code, setup_link_id FROM device_logins
        WHERE user_code IN (${first.userCode}, ${second.userCode}) ORDER BY setup_link_id NULLS LAST`;
      assert.deepStrictEqual(bound, [
        { user_code: first.userCode, setup_link_id: line.value },
        { user_code: second.userCode, setup_link_id: null }
      ]);
      // An unknown value binds nothing and the login proceeds as an ordinary one.
      const plain = yield* logins.start({ machineNameHint: "laptop", setupLink: "a".repeat(26) });
      assert.deepStrictEqual(
        yield* sql`SELECT setup_link_id FROM device_logins WHERE user_code = ${plain.userCode}`,
        [{ setup_link_id: null }]
      );
    }).pipe(withDeviceLogins)
  );

  it.effect(
    "connects on the owner's mint, reports the setup, and never counts another account",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const owner = yield* addUser("owner");
        const other = yield* addUser("other");
        const line = yield* SetupLinks.current(owner);
        const reply = yield* connect(line.value, owner);
        assert.strictEqual(reply.status, "complete");
        const status = Option.getOrThrow(yield* SetupLinks.status(owner));
        assert.strictEqual(status.outcome, "connected");
        assert.strictEqual(
          status.machineTokenId,
          reply.status === "complete" ? reply.machine.id : ""
        );
        const minted = events.findLast((event) => event.name === "token.minted");
        assert.strictEqual(minted?.properties.setupId, line.setupId);

        const theirs = yield* SetupLinks.current(other);
        yield* connect(theirs.value, owner);
        assert.deepStrictEqual(yield* outcome(other), Option.some("other_account"));
      }).pipe(withDeviceLogins)
  );

  it.effect("keeps a contested line contested when its bound login mints, with its setup id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const userId = yield* addUser("contest");
      const line = yield* SetupLinks.current(userId);
      const logins = yield* DeviceLogins.DeviceLogins;
      const bound = yield* logins.start({ machineNameHint: "laptop", setupLink: line.value });
      yield* logins.start({ machineNameHint: "elsewhere", setupLink: line.value });
      yield* logins.confirm({ userCode: bound.userCode, userId, machineName: "Laptop" });
      const reply = yield* logins.poll(bound.deviceCode);
      assert.strictEqual(reply.status, "complete");
      const status = Option.getOrThrow(yield* SetupLinks.status(userId));
      assert.strictEqual(status.outcome, "contested");
      assert.strictEqual(
        status.machineTokenId,
        reply.status === "complete" ? reply.machine.id : ""
      );
      const minted = events.findLast((event) => event.name === "token.minted");
      assert.strictEqual(minted?.properties.setupId, line.setupId);
    }).pipe(withDeviceLogins)
  );

  it.effect("ends a line expired when its login runs out, or when the line ran out first", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const sql = yield* SqlClient.SqlClient;
      const logins = yield* DeviceLogins.DeviceLogins;
      const idle = yield* addUser("idle");
      const idleLine = yield* SetupLinks.current(idle);
      const unanswered = yield* logins.start({
        machineNameHint: "laptop",
        setupLink: idleLine.value
      });
      yield* TestClock.adjust("11 minutes");
      yield* logins.poll(unanswered.deviceCode).pipe(Effect.ignore);
      assert.deepStrictEqual(yield* outcome(idle), Option.some("expired"));

      // A login bound just before the line's half hour ends that mints after it doesn't connect.
      const late = yield* addUser("late");
      const lateLine = yield* SetupLinks.current(late);
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: lateLine.value });
      yield* sql`UPDATE setup_links SET expires_at = now() - interval '1 second'
        WHERE id = ${lateLine.value}`;
      yield* logins.confirm({ userCode: login.userCode, userId: late, machineName: "Laptop" });
      assert.strictEqual((yield* logins.poll(login.deviceCode)).status, "complete");
      assert.deepStrictEqual(yield* outcome(late), Option.some("expired"));
    }).pipe(withDeviceLogins)
  );

  it.effect("cleans up an expired bound login without deadlocking an answer to it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const sql = yield* SqlClient.SqlClient;
      const logins = yield* DeviceLogins.DeviceLogins;
      const userId = yield* addUser("order");
      const line = yield* SetupLinks.current(userId);
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: line.value });
      yield* TestClock.adjust("11 minutes");
      const locked = yield* Deferred.make<void>();
      // An answer's order, the login and then its line, held open until start's cleanup waits.
      const answer = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT 1 FROM device_logins WHERE user_code = ${login.userCode} FOR UPDATE`;
            yield* Deferred.succeed(locked, undefined);
            yield* someoneWaits;
            yield* sql`SELECT 1 FROM setup_links WHERE id = ${line.value} FOR UPDATE`;
          })
        )
      );
      yield* Deferred.await(locked);
      yield* logins.start({ machineNameHint: "elsewhere" });
      yield* Fiber.join(answer);
      assert.deepStrictEqual(yield* outcome(userId), Option.some("expired"));
    }).pipe(withDeviceLogins)
  );

  it.effect("refuses an inline confirmation whose line ran out while it waited for it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const sql = yield* SqlClient.SqlClient;
      const logins = yield* DeviceLogins.DeviceLogins;
      const userId = yield* addUser("late-confirm");
      const line = yield* SetupLinks.current(userId);
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: line.value });
      yield* sql`UPDATE setup_links SET expires_at = clock_timestamp() + interval '1 second'
        WHERE id = ${line.value}`;
      const locked = yield* Deferred.make<void>();
      // Another transaction holds the line, unchanged, past its last second.
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT 1 FROM setup_links WHERE id = ${line.value} FOR UPDATE`;
            yield* Deferred.succeed(locked, undefined);
            yield* someoneWaits;
            yield* sql`SELECT pg_sleep(1.5)`;
          })
        )
      );
      yield* Deferred.await(locked);
      const answered = yield* Effect.result(
        logins.confirmInline({
          userCode: login.userCode,
          userId,
          machineName: "Laptop",
          setupLink: line.value
        })
      );
      yield* Fiber.join(holder);
      assert.isTrue(Result.isFailure(answered) && answered.failure._tag === "SetupLineChanged");
      assert.deepStrictEqual(
        yield* sql`SELECT state FROM device_logins WHERE user_code = ${login.userCode}`,
        [{ state: "pending" }]
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("prunes a day-old line only once no login names it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const sql = yield* SqlClient.SqlClient;
      const logins = yield* DeviceLogins.DeviceLogins;
      const userId = yield* addUser("prune");
      const old = yield* SetupLinks.current(userId);
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: old.value });
      yield* sql`UPDATE setup_links SET expires_at = now() - interval '2 days' WHERE id = ${old.value}`;
      const lines = sql`SELECT id FROM setup_links WHERE id = ${old.value}`;
      yield* SetupLinks.current(userId);
      assert.lengthOf(yield* lines, 1);
      yield* sql`DELETE FROM device_logins WHERE user_code = ${login.userCode}`;
      yield* SetupLinks.current(userId);
      assert.lengthOf(yield* lines, 0);
    }).pipe(withDeviceLogins)
  );

  it.effect("ends a denied login's line as denied", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const userId = yield* addUser("deny");
      const line = yield* SetupLinks.current(userId);
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "laptop", setupLink: line.value });
      yield* logins.deny(login.userCode, userId);
      assert.deepStrictEqual(yield* outcome(userId), Option.some("denied"));
    }).pipe(withDeviceLogins)
  );
});
