import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as Testing from "@patchy/sql/testing";
import { migrations } from "./migrations.js";
import * as Tokens from "./Tokens.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ PATCHY_BOOTSTRAP_API_TOKEN: "dev-token" })
);

const tokens = Effect.flatMap(Tokens.Tokens, Effect.succeed);

it.layer(Tokens.layer.pipe(Layer.provideMerge(Testing.layer(migrations)), Layer.provide(config)))(
  "Tokens",
  (it) => {
    it.effect("seeds the bootstrap principal as an admin token", () =>
      Effect.gen(function* () {
        const identity = yield* (yield* tokens).authenticate("dev-token");
        assert.deepStrictEqual(
          Option.map(identity, (found) => ({ ...found })),
          Option.some({
            accountId: Tokens.BOOTSTRAP_PRINCIPAL_ID,
            accountName: "Bootstrap Account",
            apiTokenId: Tokens.BOOTSTRAP_API_TOKEN_ID,
            apiTokenName: "Bootstrap API Token",
            scopes: ["admin", "upload"]
          })
        );
        assert.isTrue(Option.isNone(yield* (yield* tokens).authenticate("nope")));
      })
    );

    it.effect("revokes a token as a state its row keeps, exactly once", () =>
      Effect.gen(function* () {
        const service = yield* tokens;
        const created = yield* service.mint({
          sourceIp: "192.0.2.136",
          quota: 2,
          name: "Revocable token",
          token: "revocable"
        });
        assert.strictEqual(
          Option.getOrThrow(yield* service.authenticate("revocable")).apiTokenId,
          created.apiTokenId
        );

        const first = Option.getOrThrow(yield* service.revoke(created.apiTokenId));
        assert.deepStrictEqual(first, {
          id: created.apiTokenId,
          accountId: created.accountId,
          name: "Revocable token",
          revokedAt: first.revokedAt,
          alreadyRevoked: false
        });
        // Revoked is a state, never a deletion: the token authenticates nothing
        // any more, and the row it left behind is still there to be read.
        assert.isTrue(Option.isNone(yield* service.authenticate("revocable")));
        const again = Option.getOrThrow(yield* service.revoke(created.apiTokenId));
        assert.strictEqual(again.alreadyRevoked, true);
        // The first moment stands — it is when the patches' top-ups froze.
        assert.strictEqual(again.revokedAt, first.revokedAt);
        assert.isTrue(Option.isNone(yield* service.revoke("tok_never_existed")));
      })
    );

    it.effect("lets only one of two concurrent revocations claim the first stamp", () =>
      Effect.gen(function* () {
        const service = yield* tokens;
        const created = yield* service.mint({
          sourceIp: "192.0.2.137",
          quota: 1,
          name: "Doubly revoked token",
          token: "doubly"
        });
        const [first, second] = yield* Effect.all(
          [service.revoke(created.apiTokenId), service.revoke(created.apiTokenId)],
          { concurrency: "unbounded" }
        ).pipe(Effect.map((results) => results.map(Option.getOrThrow)));
        assert.deepStrictEqual([first!.alreadyRevoked, second!.alreadyRevoked].sort(), [
          false,
          true
        ]);
        assert.strictEqual(first!.revokedAt, second!.revokedAt);
      })
    );

    it.effect("mints one upload-only principal per token, under a rolling-day quota", () =>
      Effect.gen(function* () {
        const service = yield* tokens;
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const mint = (token: string, sourceIp: string | null = "198.51.100.20") =>
          service.mint({ sourceIp, quota: 2, name: "Self-service token 2026-01-01", token });

        const first = yield* mint("first");
        const second = yield* mint("second");
        assert.notStrictEqual(first.accountId, second.accountId);
        const identity = Option.getOrThrow(yield* service.authenticate("second"));
        assert.deepStrictEqual(
          { ...identity },
          {
            accountId: second.accountId,
            accountName: "Self-service token 2026-01-01",
            apiTokenId: second.apiTokenId,
            apiTokenName: "Self-service token 2026-01-01",
            scopes: ["upload"]
          }
        );

        const exceeded = yield* mint("third").pipe(Effect.flip);
        assert.strictEqual(exceeded._tag, "MintQuotaExceeded");
        assert.strictEqual(exceeded.quota, 2);
        // A refused mint leaves nothing behind: the third token does not exist.
        assert.isTrue(Option.isNone(yield* service.authenticate("third")));
        // Another address is its own bucket, and unattributed mints share one.
        yield* mint("other", "203.0.113.1");
        yield* mint("nowhere", null);
        yield* mint("nowhere-too", null);
        assert.strictEqual((yield* mint("nowhere-three", null).pipe(Effect.flip)).quota, 2);

        // The window rolls off the mints themselves rather than resetting at
        // a fixed hour: a day and a second later the oldest mint no longer counts.
        yield* TestClock.adjust(DAY_MS - 1_000);
        assert.strictEqual(
          (yield* mint("still-parked").pipe(Effect.flip))._tag,
          "MintQuotaExceeded"
        );
        yield* TestClock.adjust(2_000);
        yield* mint("fresh-day");
      })
    );
  }
);
