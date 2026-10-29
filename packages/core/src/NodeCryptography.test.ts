import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cryptography from "./Cryptography.js";
import * as NodeCryptography from "./NodeCryptography.js";

const cryptography = NodeCryptography.make;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("formats", () => {
  it("draws only counted bytes, refilling until the string is long enough", () => {
    const batches = [
      [0, 252, 35, 255],
      [37, 250]
    ];
    const asked: number[] = [];
    const bytes = (size: number) => {
      asked.push(size);
      return Uint8Array.from(batches.shift()!);
    };
    // 252 and 255 sit at or above the largest multiple of 36 (252) and are dropped; 37 wraps to "b".
    expect(NodeCryptography.sampleString(bytes, "abcdefghijklmnopqrstuvwxyz0123456789", 4)).toBe(
      "a9b8"
    );
    expect(asked).toEqual([4, 2]);
  });

  it.effect("makes ids and tokens in their stored shapes", () =>
    Effect.gen(function* () {
      expect(yield* cryptography.patchId).toMatch(/^[a-z0-9]{12}$/);
      expect(yield* cryptography.internalId("ver")).toMatch(/^ver_[a-z0-9]{24}$/);
      expect(yield* cryptography.token()).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(yield* cryptography.token(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(yield* cryptography.randomUUID).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    })
  );

  it.effect("digests strings as UTF-8", () =>
    Effect.gen(function* () {
      const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      expect(yield* cryptography.sha256("abc")).toBe(abc);
      expect(yield* cryptography.sha256(new TextEncoder().encode("abc"))).toBe(abc);
      expect(cryptography.sha256Unsafe("abc", "hex")).toBe(abc);
      expect(cryptography.sha256Unsafe("abc", "base64")).toBe(
        Buffer.from(abc, "hex").toString("base64")
      );
      expect(hex(yield* cryptography.digest("SHA-1", "abc"))).toBe(
        "a9993e364706816aba3e25717850c26c9cd0d89d"
      );
    })
  );
});

describe("keyed operations", () => {
  it.effect("computes RFC 4231's HMAC-SHA256 and RFC 5869's HKDF", () =>
    Effect.gen(function* () {
      expect(hex(yield* cryptography.hmacSha256("Jefe", "what do ya want for nothing?"))).toBe(
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
      );
      expect(hex(yield* cryptography.hkdfSha256(Buffer.alloc(22, 0x0b), "", "", 42))).toBe(
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
      );
    })
  );

  it.effect("compares bytes, and refuses different lengths instead of throwing", () =>
    Effect.gen(function* () {
      expect(yield* cryptography.equal(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
      expect(yield* cryptography.equal(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
      expect(yield* cryptography.equal(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
    })
  );

  it.effect("opens what node:crypto sealed before this service existed", () =>
    Effect.gen(function* () {
      // An integration credential sealed by CredentialKeys before it used Cryptography.
      const credential = yield* cryptography.open(
        Buffer.alloc(32, 42),
        "gtxl9rswjUkFIgoebsAzU602U/AFH/VL23RskvhjiMvTgPJJhJScQkVxogRHGVJEhuRTV3/QSkQ=",
        JSON.stringify(["co_fixture", "conn_fixture", "postgres", "fixture"])
      );
      expect(credential).toBe('{"url":"postgres://fixture"}');
      // An agent connection's retry copy, under the key its refresh token derives.
      const retryKey = yield* cryptography.hkdfSha256(
        "pwr_fixture",
        "",
        "patchy agent connection retry",
        32
      );
      const retry = yield* cryptography.open(
        retryKey,
        "WLpKKdcRHPPeS6P6RdOY4y//YIWfP3vRSILPUH4KRwY/u49wccZ9lY24lJAo8HWcelFA7o2pDBxUijTqkznVeRxBYeTAalGlrqiGkeq8W4FDays=",
        "conn_fixture"
      );
      expect(retry).toBe('{"accessToken":"pwa_fixture","refreshToken":"pwr_next"}');
    })
  );

  it.effect("seals under a fresh nonce, and opens only under the same key and context", () =>
    Effect.gen(function* () {
      const key = Buffer.alloc(32, 7);
      const first = yield* cryptography.seal(key, "secret", "context");
      const second = yield* cryptography.seal(key, "secret", "context");
      expect(first).not.toBe(second);
      expect(Buffer.from(first, "base64")).toHaveLength(12 + 16 + "secret".length);
      expect(yield* cryptography.open(key, first, "context")).toBe("secret");
      for (const [opened, sealed, context] of [
        [Buffer.alloc(32, 8), first, "context"],
        [key, first, "other"],
        [key, first.slice(0, 20), "context"]
      ] as const) {
        const failure = yield* Effect.flip(cryptography.open(opened, sealed, context));
        expect(failure).toBeInstanceOf(Cryptography.OpenFailed);
      }
      const failure = yield* Effect.flip(cryptography.seal(Buffer.alloc(16), "secret", "context"));
      expect(failure).toBeInstanceOf(Cryptography.SealFailed);
    })
  );

  it.effect("reads an RSA public key from SPKI or PKCS#1, and refuses anything else", () =>
    Effect.gen(function* () {
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const spki = publicKey.export({ type: "spki", format: "pem" }).toString();
      const pkcs1 = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
      for (const pem of [spki, pkcs1]) {
        expect(yield* cryptography.rsaPublicKey(pem)).toEqual({
          modulusLength: 2048,
          publicExponent: 65537n,
          spki
        });
      }
      const ed25519 = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
      for (const pem of [ed25519, "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----"]) {
        const failure = yield* Effect.flip(cryptography.rsaPublicKey(pem));
        expect(failure).toBeInstanceOf(Cryptography.InvalidPublicKey);
      }
    })
  );
});
