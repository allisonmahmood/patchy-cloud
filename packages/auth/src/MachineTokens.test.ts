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
});
