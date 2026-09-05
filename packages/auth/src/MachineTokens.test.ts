import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { sha256 } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as MachineTokens from "./MachineTokens.js";
import { DEV_SEED } from "./seed.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 1);

it.layer(MachineTokens.layer.pipe(Layer.provideMerge(Testing.layer())))("MachineTokens", (it) => {
  it.effect("authenticates the seeded user, company and machine", () =>
    Effect.gen(function* () {
      const tokens = yield* MachineTokens.MachineTokens;
      const identity = yield* tokens.authenticate(DEV_SEED.token);
      assert.deepStrictEqual(identity && { ...identity }, {
        user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
        company: {
          id: DEV_SEED.companyId,
          handle: DEV_SEED.companyHandle,
          name: DEV_SEED.companyName
        },
        role: DEV_SEED.role,
        machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
      });
      assert.isNull(yield* tokens.authenticate("unknown-credential"));
    })
  );

  it.effect("mints distinct hash-only credentials with a 90-day lifetime", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Work laptop" });
      const second = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Work laptop" });
      assert.notStrictEqual(first.token, second.token);
      assert.notStrictEqual(first.id, second.id);
      assert.strictEqual(first.expiresAt, new Date(NOW + 90 * DAY).toISOString());
      const rows = yield* sql<{
        tokenHash: string;
        createdAt: Date;
        lastUsedAt: Date;
        expiresAt: Date;
      }>`
      SELECT token_hash AS "tokenHash", created_at AS "createdAt", last_used_at AS "lastUsedAt",
        expires_at AS "expiresAt" FROM machine_tokens WHERE id = ${first.id}`;
      assert.deepStrictEqual(rows[0], {
        tokenHash: sha256(first.token),
        createdAt: new Date(NOW),
        lastUsedAt: new Date(NOW),
        expiresAt: new Date(NOW + 90 * DAY)
      });
      assert.strictEqual((yield* tokens.authenticate(first.token))?.machine.id, first.id);
    })
  );

  it.effect("refuses expired and idle tokens only after their exact boundaries", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const expiring = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Expiring" });
      const idle = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Idle" });
      const boundary = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Idle boundary" });
      yield* TestClock.setTime(NOW + 30 * DAY);
      assert.strictEqual((yield* tokens.authenticate(boundary.token))?.machine.id, boundary.id);
      yield* TestClock.adjust(1);
      assert.isNull(yield* tokens.authenticate(idle.token));
      // Keep this key active so the absolute lifetime, not idleness, refuses it.
      yield* sql`UPDATE machine_tokens SET last_used_at = to_timestamp(${(NOW + 89 * DAY) / 1_000})
      WHERE id = ${expiring.id}`;
      yield* TestClock.setTime(NOW + 90 * DAY);
      assert.strictEqual((yield* tokens.authenticate(expiring.token))?.machine.id, expiring.id);
      yield* TestClock.adjust(1);
      assert.isNull(yield* tokens.authenticate(expiring.token));
    })
  );

  it.effect(
    "stamps successful use hourly and never regresses under concurrent or older lookups",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const tokens = yield* MachineTokens.MachineTokens;
        const sql = yield* SqlClient.SqlClient;
        const minted = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Hourly" });
        const stamp = Effect.map(
          sql<{ at: Date }>`SELECT last_used_at AS at FROM machine_tokens WHERE id = ${minted.id}`,
          (rows) => rows[0]!.at.getTime()
        );
        yield* TestClock.adjust(HOUR - 1);
        yield* tokens.authenticate(minted.token);
        assert.strictEqual(yield* stamp, NOW);
        yield* TestClock.adjust(1);
        yield* Effect.all([tokens.authenticate(minted.token), tokens.authenticate(minted.token)], {
          concurrency: "unbounded"
        });
        assert.strictEqual(yield* stamp, NOW + HOUR);
        yield* TestClock.adjust(HOUR - 1);
        yield* tokens.authenticate(minted.token);
        assert.strictEqual(yield* stamp, NOW + HOUR);
        yield* TestClock.adjust(1);
        yield* tokens.authenticate(minted.token);
        assert.strictEqual(yield* stamp, NOW + 2 * HOUR);
        yield* TestClock.setTime(NOW);
        yield* tokens.authenticate(minted.token);
        assert.strictEqual(yield* stamp, NOW + 2 * HOUR);
      })
  );

  it.effect("revokes exactly once under concurrency and preserves the first stamp", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const minted = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Revocable" });
      const results = yield* Effect.all([tokens.revoke(minted.id), tokens.revoke(minted.id)], {
        concurrency: "unbounded"
      });
      assert.deepStrictEqual(results.map((result) => result.alreadyRevoked).sort(), [false, true]);
      yield* TestClock.adjust(HOUR);
      assert.deepStrictEqual(yield* tokens.revoke(minted.id), { alreadyRevoked: true });
      assert.isNull(yield* tokens.authenticate(minted.token));
      const rows = yield* sql<{ revokedAt: Date; lastUsedAt: Date }>`
      SELECT revoked_at AS "revokedAt", last_used_at AS "lastUsedAt" FROM machine_tokens WHERE id = ${minted.id}`;
      assert.deepStrictEqual(rows[0], { revokedAt: new Date(NOW), lastUsedAt: new Date(NOW) });
      assert.strictEqual(
        (yield* tokens.revoke("tok_missing").pipe(Effect.flip))._tag,
        "MachineTokenNotFound"
      );
    })
  );

  it.effect("deactivation refuses even an unrevoked key and prevents new credentials", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES ('usr_auth_inactive', 'user_auth_inactive', ${DEV_SEED.companyId}, 'inactive@auth.test', 'Inactive', 'member')`;
      const minted = yield* tokens.mint({ userId: "usr_auth_inactive", name: "Inactive laptop" });
      yield* sql`UPDATE users SET deactivated_at = to_timestamp(${NOW / 1_000}) WHERE id = 'usr_auth_inactive'`;
      assert.isNull(yield* tokens.authenticate(minted.token));
      assert.strictEqual(
        (yield* tokens.mint({ userId: "usr_auth_inactive", name: "No" }).pipe(Effect.flip))._tag,
        "UserUnavailable"
      );
      assert.strictEqual(
        (yield* tokens.mint({ userId: "usr_missing", name: "No" }).pipe(Effect.flip))._tag,
        "UserUnavailable"
      );
      for (const name of ["", "   ", "x".repeat(65)]) {
        assert.strictEqual(
          (yield* tokens.mint({ userId: DEV_SEED.userId, name }).pipe(Effect.flip))._tag,
          "InvalidMachineName"
        );
      }
    })
  );

  it.effect("lists only the user's live machines with their lifecycle timestamps", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = "usr_machine_list";
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${userId}, 'user_machine_list', ${DEV_SEED.companyId}, 'list@auth.test', 'List', 'member')`;
      const live = yield* tokens.mint({ userId, name: "Live laptop" });
      const revoked = yield* tokens.mint({ userId, name: "Revoked laptop" });
      const expired = yield* tokens.mint({ userId, name: "Expired laptop" });
      const idle = yield* tokens.mint({ userId, name: "Idle laptop" });
      yield* tokens.revoke(revoked.id);
      yield* sql`UPDATE machine_tokens SET expires_at = to_timestamp(${(NOW - 1) / 1_000})
        WHERE id = ${expired.id}`;
      yield* sql`UPDATE machine_tokens SET last_used_at = to_timestamp(${(NOW - 30 * DAY - 1) / 1_000})
        WHERE id = ${idle.id}`;
      yield* tokens.mint({ userId: DEV_SEED.userId, name: "Someone else's laptop" });
      assert.deepStrictEqual(yield* tokens.list(userId), [
        {
          id: live.id,
          name: "Live laptop",
          createdAt: new Date(NOW).toISOString(),
          lastUsedAt: new Date(NOW).toISOString(),
          expiresAt: live.expiresAt
        }
      ]);
      yield* TestClock.adjust(HOUR);
      yield* tokens.authenticate(live.token);
      assert.strictEqual(
        (yield* tokens.list(userId))[0]?.lastUsedAt,
        new Date(NOW + HOUR).toISOString()
      );
      yield* sql`UPDATE users SET deactivated_at = to_timestamp(${NOW / 1_000}) WHERE id = ${userId}`;
      assert.deepStrictEqual(yield* tokens.list(userId), []);
    })
  );

  it.effect("owned revocation hides foreign ids and only the owner can revoke", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const tokens = yield* MachineTokens.MachineTokens;
      const minted = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Owned" });
      for (const input of [
        { id: minted.id, userId: "usr_foreign" },
        { id: "tok_missing_owned", userId: DEV_SEED.userId }
      ]) {
        assert.strictEqual(
          (yield* tokens.revokeOwned(input).pipe(Effect.flip))._tag,
          "MachineTokenNotFound"
        );
      }
      assert.strictEqual((yield* tokens.authenticate(minted.token))?.machine.id, minted.id);
      const input = { id: minted.id, userId: DEV_SEED.userId };
      const results = yield* Effect.all([tokens.revokeOwned(input), tokens.revokeOwned(input)], {
        concurrency: "unbounded"
      });
      assert.deepStrictEqual(results.map((result) => result.alreadyRevoked).sort(), [false, true]);
      assert.isNull(yield* tokens.authenticate(minted.token));
    })
  );

  it.effect("revoke all preserves old stamps and rows without touching another user's key", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const userId = "usr_machine_all";
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${userId}, 'user_machine_all', ${DEV_SEED.companyId}, 'all@auth.test', 'All', 'member')`;
      const laptop = yield* tokens.mint({ userId, name: "Laptop" });
      const desktop = yield* tokens.mint({ userId, name: "Desktop" });
      const earlier = yield* tokens.mint({ userId, name: "Earlier" });
      const foreign = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Unaffected" });
      yield* tokens.revoke(earlier.id);
      yield* TestClock.adjust(HOUR);
      yield* tokens.revokeAll(userId);
      yield* TestClock.adjust(HOUR);
      yield* tokens.revokeAll(userId);
      assert.deepStrictEqual(yield* tokens.list(userId), []);
      for (const token of [laptop.token, desktop.token, earlier.token]) {
        assert.isNull(yield* tokens.authenticate(token));
      }
      assert.strictEqual((yield* tokens.authenticate(foreign.token))?.machine.id, foreign.id);
      const rows = yield* sql<{ name: string; revokedAt: Date }>`
        SELECT name, revoked_at AS "revokedAt" FROM machine_tokens WHERE user_id = ${userId} ORDER BY name`;
      assert.deepStrictEqual(rows, [
        { name: "Desktop", revokedAt: new Date(NOW + HOUR) },
        { name: "Earlier", revokedAt: new Date(NOW) },
        { name: "Laptop", revokedAt: new Date(NOW + HOUR) }
      ]);
    })
  );
});
