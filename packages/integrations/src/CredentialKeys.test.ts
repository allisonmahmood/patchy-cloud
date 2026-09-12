import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as CredentialKeys from "./CredentialKeys.js";

const oldKey = Buffer.alloc(32, 11).toString("base64");
const newKey = Buffer.alloc(32, 29).toString("base64");
const identity = {
  companyId: "company-one",
  id: "connection-one",
  integration: "postgres" as const
};
const credentials = Redacted.make(
  "postgresql://reader:never-log-this@warehouse.example/sales?sslmode=verify-full"
);

it.effect(
  "activates the first key while keeping persisted ciphertext decryptable after rotation",
  () =>
    Effect.gen(function* () {
      const oldRing = yield* CredentialKeys.makeFromKeys(Redacted.make(`old:${oldKey}`));
      const persisted = yield* oldRing.encrypt(identity, credentials);
      const rotated = yield* CredentialKeys.makeFromKeys(
        Redacted.make(`new:${newKey},old:${oldKey}`)
      );
      assert.strictEqual(
        Redacted.value(yield* rotated.decrypt(identity, persisted)),
        Redacted.value(credentials)
      );
      const rewritten = yield* rotated.encrypt(identity, credentials);
      assert.strictEqual(rewritten.keyId, "new");
      assert.strictEqual(
        (yield* oldRing.decrypt(identity, rewritten).pipe(Effect.flip)).code,
        "credential_decryption_failed"
      );
      const currentOnly = yield* CredentialKeys.makeFromKeys(Redacted.make(`new:${newKey}`));
      assert.strictEqual(
        Redacted.value(yield* currentOnly.decrypt(identity, rewritten)),
        Redacted.value(credentials)
      );
    })
);

it.effect("uses fresh nonces and rejects tampering with every authenticated part", () =>
  Effect.gen(function* () {
    const keys = yield* CredentialKeys.makeFromKeys(
      Redacted.make(`current:${newKey},same-material:${newKey}`)
    );
    const first = yield* keys.encrypt(identity, credentials);
    const second = yield* keys.encrypt(identity, credentials);
    assert.notDeepEqual(
      Buffer.from(first.credentials, "base64").subarray(0, 12),
      Buffer.from(second.credentials, "base64").subarray(0, 12)
    );
    for (const offset of [0, 12, 28]) {
      const bytes = Buffer.from(first.credentials, "base64");
      bytes[offset] = bytes[offset]! ^ 1;
      const error = yield* keys
        .decrypt(identity, { ...first, credentials: bytes.toString("base64") })
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "credential_decryption_failed");
      assert.notInclude(JSON.stringify(error), "never-log-this");
    }
    assert.strictEqual(
      (yield* keys.decrypt(identity, { ...first, keyId: "same-material" }).pipe(Effect.flip)).code,
      "credential_decryption_failed"
    );
    for (const changed of [
      { ...identity, companyId: "company-two" },
      { ...identity, id: "connection-two" }
    ]) {
      assert.strictEqual(
        (yield* keys.decrypt(changed, first).pipe(Effect.flip)).code,
        "credential_decryption_failed"
      );
    }
  })
);

it.effect("rejects malformed, truncated and noncanonical ciphertext with one safe failure", () =>
  Effect.gen(function* () {
    const keys = yield* CredentialKeys.makeFromKeys(Redacted.make(`current:${newKey}`));
    for (const ciphertext of ["", "not base64", Buffer.alloc(27).toString("base64")]) {
      const error = yield* keys
        .decrypt(identity, { keyId: "current", credentials: ciphertext })
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "credential_decryption_failed");
      assert.strictEqual(error.status, 503);
    }
  })
);

it.effect("rejects invalid keyrings before startup without exposing their contents", () =>
  Effect.gen(function* () {
    const invalid = [
      "",
      `same:${newKey},same:${oldKey}`,
      `new:${newKey},`,
      `new: ${newKey}`,
      `new:${Buffer.alloc(31).toString("base64")}`,
      `new:${newKey.replace(/=$/, "")}`,
      `new:${newKey}\n`
    ];
    for (const value of invalid) {
      const error = yield* CredentialKeys.config
        .parse(ConfigProvider.fromUnknown({ PATCHY_CREDENTIAL_KEYS: value }))
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ConfigError");
      assert.notInclude(error.message, newKey);
      assert.notInclude(JSON.stringify(error), newKey);
    }
    const missing = yield* CredentialKeys.config
      .parse(ConfigProvider.fromUnknown({}))
      .pipe(Effect.flip);
    assert.strictEqual(missing._tag, "ConfigError");
  })
);
