import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Users } from "@patchy/companies";
import { sha256 } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import { DEV_SEED } from "./seed.js";

const NOW = Date.UTC(2026, 0, 1);
const MINUTE = 60 * 1_000;
const DAY = 24 * 60 * MINUTE;
const events: Analytics.AnalyticsEvent[] = [];
const recording = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);
const layer = Layer.mergeAll(MachineTokens.layer, Users.layer, recording).pipe(
  Layer.provideMerge(Testing.layer())
);
// Each scenario gets fresh limiter windows; the database is shared as in the
// other service suites, but its test clock can rewind between scenarios.
const withDeviceLogins = Effect.provide(DeviceLogins.layer.pipe(Layer.provide(Limits.layer)));

const addUser = Effect.fn("DeviceLogins.test.addUser")(function* (suffix: string) {
  const sql = yield* SqlClient.SqlClient;
  const id = `usr_device_${suffix}`;
  yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES (${id}, ${`user_device_${suffix}`}, ${DEV_SEED.companyId},
      ${`${suffix}@device.test`}, ${suffix}, 'member')`;
  return id;
});

it.layer(layer)("DeviceLogins", (it) => {
  it.effect("starts hash-only, confirms without minting, then returns one 90-day credential", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("complete");
      const login = yield* logins.start({ machineNameHint: "hostname" });
      assert.match(login.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      assert.strictEqual(login.interval, 5);
      assert.strictEqual(login.expiresAt, new Date(NOW + 10 * MINUTE).toISOString());
      assert.deepStrictEqual(
        yield* sql`
        SELECT device_code_hash, state, user_id, machine_name FROM device_logins
        WHERE user_code = ${login.userCode}`,
        [
          {
            device_code_hash: sha256(login.deviceCode),
            state: "pending",
            user_id: null,
            machine_name: null
          }
        ]
      );
      assert.deepStrictEqual(yield* logins.lookup(login.userCode, userId), {
        userCode: login.userCode,
        machineNameHint: "hostname",
        oldMachineName: null,
        expiresAt: login.expiresAt
      });
      assert.deepStrictEqual(yield* logins.poll(login.deviceCode), { status: "pending" });
      yield* logins.confirm({ userCode: login.userCode, userId, machineName: "Work laptop" });
      assert.deepStrictEqual(yield* tokens.list(userId), []);
      assert.deepStrictEqual(yield* logins.poll(login.deviceCode), {
        status: "slow_down"
      });
      yield* TestClock.adjust(5_000);
      const result = yield* logins.poll(login.deviceCode);
      assert.strictEqual(result.status, "complete");
      if (result.status !== "complete") return;
      assert.strictEqual(result.machine.name, "Work laptop");
      assert.strictEqual(result.expiresAt, new Date(NOW + 5_000 + 90 * DAY).toISOString());
      assert.deepStrictEqual(result.company, {
        handle: DEV_SEED.companyHandle,
        name: DEV_SEED.companyName
      });
      assert.deepStrictEqual(result.user, { email: "complete@device.test" });
      assert.strictEqual((yield* tokens.authenticate(result.token))?.user.id, userId);
      assert.deepStrictEqual(
        yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${login.userCode}`,
        []
      );
      assert.strictEqual(
        (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
      assert.deepStrictEqual(
        events.filter((event) => event.principalId === userId),
        [
          {
            name: "token.minted",
            principalId: userId,
            properties: { tokenId: result.machine.id, replaced: false }
          }
        ]
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("limits each device at the exact interval without delaying another device", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const first = yield* logins.start({ machineNameHint: "first" });
      const second = yield* logins.start({ machineNameHint: "second" });
      assert.notStrictEqual(first.userCode, second.userCode);
      assert.notStrictEqual(first.deviceCode, second.deviceCode);
      assert.deepStrictEqual(yield* logins.poll(first.deviceCode), { status: "pending" });
      yield* TestClock.adjust(4_999);
      assert.deepStrictEqual(yield* logins.poll(first.deviceCode), {
        status: "slow_down"
      });
      assert.deepStrictEqual(yield* logins.poll(second.deviceCode), {
        status: "pending"
      });
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(yield* logins.poll(first.deviceCode), { status: "pending" });
    }).pipe(withDeviceLogins)
  );

  it.effect("denial wins over a poll window and is consumed without minting", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const sql = yield* SqlClient.SqlClient;
      const login = yield* logins.start({ machineNameHint: "denied" });
      yield* logins.poll(login.deviceCode);
      yield* logins.deny(login.userCode, DEV_SEED.userId);
      assert.strictEqual(
        (yield* logins
          .confirm({
            userCode: login.userCode,
            userId: DEV_SEED.userId,
            machineName: "No"
          })
          .pipe(Effect.flip))._tag,
        "DeviceLoginAnswered"
      );
      assert.strictEqual(
        (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
        "DeviceLoginDenied"
      );
      assert.deepStrictEqual(
        yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${login.userCode}`,
        []
      );
      assert.strictEqual(
        (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("expiry is terminal at ten minutes for pending and confirmed logins", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("expiry");
      const pending = yield* logins.start({ machineNameHint: "pending expiry" });
      const confirmed = yield* logins.start({ machineNameHint: "confirmed expiry" });
      yield* logins.confirm({ userCode: confirmed.userCode, userId, machineName: "Never minted" });
      yield* TestClock.adjust(10 * MINUTE - 1);
      assert.deepStrictEqual(yield* logins.poll(pending.deviceCode), {
        status: "pending"
      });
      yield* TestClock.adjust(1);
      for (const login of [pending, confirmed]) {
        assert.strictEqual(
          (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
          "DeviceLoginExpired"
        );
        assert.deepStrictEqual(
          yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${login.userCode}`,
          []
        );
        assert.strictEqual(
          (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
          "DeviceLoginUnknown"
        );
      }
      assert.deepStrictEqual(yield* tokens.list(userId), []);
      assert.deepStrictEqual(
        events.filter((event) => event.principalId === userId),
        []
      );
    }).pipe(withDeviceLogins)
  );

  it.effect(
    "expired page operations preserve the terminal answer, while new starts prune abandoned rows",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const logins = yield* DeviceLogins.DeviceLogins;
        const sql = yield* SqlClient.SqlClient;
        const look = yield* logins.start({ machineNameHint: "expired lookup" });
        const confirm = yield* logins.start({ machineNameHint: "expired confirm" });
        const deny = yield* logins.start({ machineNameHint: "expired deny" });
        const abandoned = yield* logins.start({ machineNameHint: "expired abandoned" });
        yield* TestClock.adjust(10 * MINUTE);
        assert.strictEqual(
          (yield* logins.lookup(look.userCode, DEV_SEED.userId).pipe(Effect.flip))._tag,
          "DeviceLoginExpired"
        );
        assert.strictEqual(
          (yield* logins
            .confirm({ userCode: confirm.userCode, userId: DEV_SEED.userId, machineName: "No" })
            .pipe(Effect.flip))._tag,
          "DeviceLoginExpired"
        );
        assert.strictEqual(
          (yield* logins.deny(deny.userCode, DEV_SEED.userId).pipe(Effect.flip))._tag,
          "DeviceLoginExpired"
        );
        for (const login of [look, confirm, deny]) {
          assert.strictEqual(
            (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
            "DeviceLoginExpired"
          );
          assert.deepStrictEqual(
            yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${login.userCode}`,
            []
          );
          assert.strictEqual(
            (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
            "DeviceLoginUnknown"
          );
        }
        const fresh = yield* logins.start({
          machineNameHint: "fresh",
          previousMachineTokenId: "tok_does_not_exist"
        });
        assert.deepStrictEqual(
          yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${abandoned.userCode}`,
          []
        );
        assert.deepStrictEqual(yield* logins.lookup(fresh.userCode, DEV_SEED.userId), {
          userCode: fresh.userCode,
          machineNameHint: "fresh",
          oldMachineName: null,
          expiresAt: fresh.expiresAt
        });
      }).pipe(withDeviceLogins)
  );

  it.effect("rejects invalid names without answering, and the first answer is final", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("names");
      const login = yield* logins.start({ machineNameHint: "name" });
      for (const machineName of ["", "   ", "x".repeat(65), "\u{10400}".repeat(65)]) {
        assert.strictEqual(
          (yield* logins
            .confirm({ userCode: login.userCode, userId, machineName })
            .pipe(Effect.flip))._tag,
          "InvalidMachineName"
        );
      }
      assert.deepStrictEqual(
        yield* sql`SELECT state, user_id, machine_name FROM device_logins WHERE user_code = ${login.userCode}`,
        [{ state: "pending", user_id: null, machine_name: null }]
      );
      const machineName = "\u{10400}".repeat(64);
      yield* logins.confirm({ userCode: login.userCode, userId, machineName });
      assert.strictEqual(
        (yield* logins
          .confirm({
            userCode: login.userCode,
            userId: DEV_SEED.userId,
            machineName: "Hijack"
          })
          .pipe(Effect.flip))._tag,
        "DeviceLoginAnswered"
      );
      assert.strictEqual(
        (yield* logins.deny(login.userCode, userId).pipe(Effect.flip))._tag,
        "DeviceLoginAnswered"
      );
      assert.strictEqual(
        (yield* logins.lookup(login.userCode, userId).pipe(Effect.flip))._tag,
        "DeviceLoginAnswered"
      );
      const result = yield* logins.poll(login.deviceCode);
      if (result.status !== "complete") assert.fail("Valid code-point boundary name should mint");
      else assert.strictEqual(result.machine.name, machineName);
      assert.strictEqual(
        (yield* logins.lookup("missing-user-code", userId).pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
      assert.strictEqual(
        (yield* logins
          .confirm({
            userCode: "missing-user-code",
            userId,
            machineName: "Unknown"
          })
          .pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
      assert.strictEqual(
        (yield* logins.deny("missing-user-code", userId).pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("inherits and replaces only the confirming user's old key", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const tokens = yield* MachineTokens.MachineTokens;
      const userId = yield* addUser("replacement");
      const foreignId = yield* addUser("foreign");
      const owned = yield* tokens.mint({ userId, name: "Old laptop" });
      const foreign = yield* tokens.mint({ userId: foreignId, name: "Private name" });
      for (const [old, expectedName, replaced] of [
        [owned, "Old laptop", true],
        [foreign, null, false]
      ] as const) {
        const login = yield* logins.start({
          machineNameHint: "host",
          previousMachineTokenId: old.id
        });
        const pending = yield* logins.lookup(login.userCode, userId);
        assert.strictEqual(pending.oldMachineName, expectedName);
        yield* logins.confirm({ userCode: login.userCode, userId, machineName: "Replacement" });
        assert.strictEqual((yield* tokens.authenticate(old.token))?.machine.id, old.id);
        const result = yield* logins.poll(login.deviceCode);
        if (result.status !== "complete") assert.fail("Confirmed replacement should mint");
        else
          assert.deepStrictEqual(
            events.filter((event) => event.properties.tokenId === result.machine.id),
            [
              {
                name: "token.minted",
                principalId: userId,
                properties: { tokenId: result.machine.id, replaced }
              }
            ]
          );
      }
      assert.isNull(yield* tokens.authenticate(owned.token));
      assert.strictEqual((yield* tokens.authenticate(foreign.token))?.user.id, foreignId);
    }).pipe(withDeviceLogins)
  );

  it.effect("expired and revoked old keys still lend their names", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("dead_names");
      const expired = yield* tokens.mint({ userId, name: "Expired name" });
      const revoked = yield* tokens.mint({ userId, name: "Revoked name" });
      yield* sql`UPDATE machine_tokens SET expires_at = to_timestamp(${(NOW - 1) / 1_000}) WHERE id = ${expired.id}`;
      yield* tokens.revoke(revoked.id);
      for (const old of [expired, revoked]) {
        const login = yield* logins.start({
          machineNameHint: "host",
          previousMachineTokenId: old.id
        });
        const owned = yield* logins.lookup(login.userCode, userId);
        const foreign = yield* logins.lookup(login.userCode, DEV_SEED.userId);
        assert.strictEqual(owned.oldMachineName, old.name);
        assert.isNull(foreign.oldMachineName);
        yield* logins.confirm({ userCode: login.userCode, userId, machineName: old.name });
        const result = yield* logins.poll(login.deviceCode);
        if (result.status !== "complete")
          assert.fail("Dead old keys should not prevent a fresh login");
        else {
          assert.strictEqual((yield* tokens.authenticate(result.token))?.machine.name, old.name);
          // An owned dead predecessor still describes re-login succession.
          assert.deepStrictEqual(
            events.filter((event) => event.properties.tokenId === result.machine.id),
            [
              {
                name: "token.minted",
                principalId: userId,
                properties: { tokenId: result.machine.id, replaced: true }
              }
            ]
          );
        }
      }
    }).pipe(withDeviceLogins)
  );

  it.effect("an abandoned confirmation neither mints nor revokes the old key", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("abandoned");
      const old = yield* tokens.mint({ userId, name: "Keep working" });
      const login = yield* logins.start({
        machineNameHint: "host",
        previousMachineTokenId: old.id
      });
      yield* logins.confirm({ userCode: login.userCode, userId, machineName: "Never minted" });
      yield* TestClock.adjust(10 * MINUTE);
      yield* logins.start({ machineNameHint: "prune" });
      assert.strictEqual((yield* tokens.authenticate(old.token))?.machine.id, old.id);
      assert.deepStrictEqual(
        (yield* tokens.list(userId)).map((machine) => machine.id),
        [old.id]
      );
      assert.deepStrictEqual(
        yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${login.userCode}`,
        []
      );
      assert.deepStrictEqual(
        events.filter((event) => event.principalId === userId),
        []
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("two concurrent polls mint exactly once and the loser answers unknown", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("concurrent");
      const login = yield* logins.start({ machineNameHint: "race" });
      yield* logins.confirm({ userCode: login.userCode, userId, machineName: "Winner" });
      const results = yield* Effect.all(
        [
          logins
            .poll(login.deviceCode)
            .pipe(Effect.catchTags({ DeviceLoginUnknown: (error) => Effect.succeed(error) })),
          logins
            .poll(login.deviceCode)
            .pipe(Effect.catchTags({ DeviceLoginUnknown: (error) => Effect.succeed(error) }))
        ],
        { concurrency: "unbounded" }
      );
      assert.deepStrictEqual(
        results.map((result) => ("_tag" in result ? result._tag : result.status)).sort(),
        ["DeviceLoginUnknown", "complete"]
      );
      const complete = results.find(
        (result) => !("_tag" in result) && result.status === "complete"
      );
      if (!complete || "_tag" in complete || complete.status !== "complete")
        assert.fail("One poll must finish the login");
      else {
        assert.deepStrictEqual(
          (yield* tokens.list(userId)).map((machine) => machine.id),
          [complete.machine.id]
        );
        assert.strictEqual((yield* tokens.authenticate(complete.token))?.user.id, userId);
        assert.deepStrictEqual(
          events.filter((event) => event.principalId === userId),
          [
            {
              name: "token.minted",
              principalId: userId,
              properties: { tokenId: complete.machine.id, replaced: false }
            }
          ]
        );
      }
      assert.deepStrictEqual(
        yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${login.userCode}`,
        []
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("deactivation between confirmation and polling consumes the login with no token", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const users = yield* Users.Users;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("deactivated");
      const login = yield* logins.start({ machineNameHint: "departed" });
      yield* logins.confirm({ userCode: login.userCode, userId, machineName: "No access" });
      yield* users.deactivate({ companyId: DEV_SEED.companyId, userId });
      assert.strictEqual(
        (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
      assert.deepStrictEqual(
        yield* sql`SELECT id FROM machine_tokens WHERE user_id = ${userId}`,
        []
      );
      assert.deepStrictEqual(
        yield* sql`SELECT user_code FROM device_logins WHERE user_code = ${login.userCode}`,
        []
      );
      assert.deepStrictEqual(
        events.filter((event) => event.principalId === userId),
        []
      );
      yield* users.reactivate({ companyId: DEV_SEED.companyId, userId });
      assert.strictEqual(
        (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("a failed terminal delete rolls back mint and replacement and emits no event", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* addUser("rollback");
      const old = yield* tokens.mint({ userId, name: "Still live" });
      const login = yield* logins.start({
        machineNameHint: "host",
        previousMachineTokenId: old.id
      });
      yield* logins.confirm({ userCode: login.userCode, userId, machineName: "Atomic" });
      yield* sql.unsafe(`CREATE FUNCTION fail_device_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'device deletion unavailable'; END $$;
        CREATE TRIGGER fail_device_delete BEFORE DELETE ON device_logins
        FOR EACH ROW EXECUTE FUNCTION fail_device_delete()`);
      yield* Effect.gen(function* () {
        assert.strictEqual(
          (yield* logins.poll(login.deviceCode).pipe(Effect.flip))._tag,
          "SqlError"
        );
        assert.deepStrictEqual(
          (yield* tokens.list(userId)).map((machine) => machine.id),
          [old.id]
        );
        assert.strictEqual((yield* tokens.authenticate(old.token))?.machine.id, old.id);
        assert.deepStrictEqual(
          events.filter((event) => event.principalId === userId),
          []
        );
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM device_logins WHERE user_code = ${login.userCode}`,
          [{ state: "confirmed" }]
        );
      }).pipe(
        Effect.ensuring(
          sql
            .unsafe(
              `DROP TRIGGER fail_device_delete ON device_logins;
        DROP FUNCTION fail_device_delete()`
            )
            .pipe(Effect.orDie)
        )
      );
      yield* TestClock.adjust(5_000);
      const retry = yield* logins.poll(login.deviceCode);
      if (retry.status !== "complete") assert.fail("Retry should finish the intact login");
      else assert.strictEqual((yield* tokens.authenticate(retry.token))?.user.id, userId);
      assert.isNull(yield* tokens.authenticate(old.token));
    }).pipe(withDeviceLogins)
  );

  it.effect("charges lookup, confirm and deny once each against the same per-user allowance", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const userId = yield* addUser("answer_limit");
      const confirmed = yield* logins.start({ machineNameHint: "confirm allowance" });
      const denied = yield* logins.start({ machineNameHint: "deny allowance" });
      const invalid = yield* logins.start({ machineNameHint: "invalid allowance" });
      assert.strictEqual(
        (yield* logins
          .confirm({
            userCode: invalid.userCode,
            userId,
            machineName: ""
          })
          .pipe(Effect.flip))._tag,
        "InvalidMachineName"
      );
      assert.strictEqual(
        (yield* logins
          .confirm({
            userCode: "missing",
            userId,
            machineName: "Unknown"
          })
          .pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
      assert.strictEqual(
        (yield* logins.deny("missing", userId).pipe(Effect.flip))._tag,
        "DeviceLoginUnknown"
      );
      for (let attempt = 0; attempt < 4; attempt++) {
        assert.strictEqual(
          (yield* logins.lookup("missing", userId).pipe(Effect.flip))._tag,
          "DeviceLoginUnknown"
        );
      }
      yield* logins.confirm({ userCode: confirmed.userCode, userId, machineName: "Eighth" });
      yield* logins.deny(denied.userCode, userId);
      assert.strictEqual(
        (yield* logins.lookup(denied.userCode, userId).pipe(Effect.flip))._tag,
        "DeviceLoginAnswered"
      );
      for (const operation of [
        logins.lookup(denied.userCode, userId),
        logins.confirm({ userCode: invalid.userCode, userId, machineName: "Blocked" }),
        logins.deny(invalid.userCode, userId)
      ]) {
        assert.strictEqual((yield* operation.pipe(Effect.flip))._tag, "DeviceLoginLookupLimited");
      }
      yield* TestClock.adjust(MINUTE);
      assert.strictEqual(
        (yield* logins.lookup(invalid.userCode, userId)).userCode,
        invalid.userCode
      );
      yield* logins.confirm({ userCode: invalid.userCode, userId, machineName: "After reset" });
      assert.strictEqual(
        (yield* logins.lookup(invalid.userCode, userId).pipe(Effect.flip))._tag,
        "DeviceLoginAnswered"
      );
    }).pipe(withDeviceLogins)
  );

  it.effect("bounds page lookups per user, including unknown codes, until the window resets", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const logins = yield* DeviceLogins.DeviceLogins;
      const login = yield* logins.start({ machineNameHint: "limited" });
      for (let index = 0; index < 10; index++) {
        assert.strictEqual(
          (yield* logins.lookup("missing-user-code", "usr_lookup_limited").pipe(Effect.flip))._tag,
          "DeviceLoginUnknown"
        );
      }
      const limited = yield* logins.lookup(login.userCode, "usr_lookup_limited").pipe(Effect.flip);
      assert.strictEqual(limited._tag, "DeviceLoginLookupLimited");
      if (limited._tag === "DeviceLoginLookupLimited")
        assert.strictEqual(limited.retryAfterSeconds, 60);
      assert.strictEqual(
        (yield* logins.lookup(login.userCode, DEV_SEED.userId)).userCode,
        login.userCode
      );
      yield* TestClock.adjust(MINUTE);
      assert.strictEqual(
        (yield* logins.lookup(login.userCode, "usr_lookup_limited")).userCode,
        login.userCode
      );
    }).pipe(withDeviceLogins)
  );
});
