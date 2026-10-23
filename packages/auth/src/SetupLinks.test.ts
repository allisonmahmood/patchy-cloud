import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
        assert.match(first.value, /^[A-Za-z0-9_-]{22}$/);
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
      const plain = yield* logins.start({ machineNameHint: "laptop", setupLink: "x".repeat(22) });
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
