// @effect-diagnostics nodeBuiltinImport:off -- Cryptography's Node implementation: the one place production code reaches node:crypto.
/**
 * `Cryptography` over `node:crypto`. Bun implements the same module; a Web Crypto implementation
 * would replace this file and nothing else.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cryptography from "./Cryptography.js";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const hashName = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-512": "sha512" } as const;

/**
 * Uniform characters from rejection sampling: a byte counts only below the largest multiple of
 * the alphabet's size, and more bytes are drawn until `length` have counted.
 */
export const sampleString = (
  bytes: (size: number) => Uint8Array,
  alphabet: string,
  length: number
): string => {
  if (alphabet.length === 0 || alphabet.length > 256)
    throw new RangeError("An alphabet holds 1 to 256 characters.");
  const limit = 256 - (256 % alphabet.length);
  let value = "";
  while (value.length < length) {
    for (const byte of bytes(length - value.length)) {
      if (byte < limit && value.length < length) value += alphabet[byte % alphabet.length];
    }
  }
  return value;
};

export const make = Cryptography.Cryptography.of({
  randomBytes: (size) => Effect.sync(() => Uint8Array.from(randomBytes(size))),
  randomString: (alphabet, length) =>
    Effect.sync(() => sampleString(randomBytes, alphabet, length)),
  randomUUID: Effect.sync(() => randomUUID()),
  patchId: Effect.sync(() => sampleString(randomBytes, ID_ALPHABET, 12)),
  internalId: (prefix) =>
    Effect.sync(() => `${prefix}_${sampleString(randomBytes, ID_ALPHABET, 24)}`),
  token: (bytes = 32) => Effect.sync(() => randomBytes(bytes).toString("base64url")),
  digest: (algorithm, data) =>
    Effect.sync(() => Uint8Array.from(createHash(hashName[algorithm]).update(data).digest())),
  sha256: (data) => Effect.sync(() => createHash("sha256").update(data).digest("hex")),
  sha256Unsafe: (data, encoding) => createHash("sha256").update(data).digest(encoding),
  hmacSha256: (key, data) =>
    Effect.sync(() => Uint8Array.from(createHmac("sha256", key).update(data).digest())),
  equal: (a, b) => Effect.sync(() => a.length === b.length && timingSafeEqual(a, b)),
  hkdfSha256: (secret, salt, info, length) =>
    Effect.sync(() => new Uint8Array(hkdfSync("sha256", secret, salt, info, length))),
  seal: (key, plaintext, context) =>
    Effect.try({
      try: () => {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(context));
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
      },
      catch: (cause) => new Cryptography.SealFailed({ cause })
    }),
  open: (key, sealed, context) =>
    Effect.try({
      try: () => {
        const bytes = Buffer.from(sealed, "base64");
        if (bytes.length < NONCE_BYTES + TAG_BYTES) throw new Error("too short");
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_BYTES));
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
        return Buffer.concat([
          decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)),
          decipher.final()
        ]).toString("utf8");
      },
      // Why it failed stays here: it would say which of key, context or value was wrong.
      catch: () => new Cryptography.OpenFailed()
    }),
  rsaPublicKey: (pem) =>
    Effect.gen(function* () {
      const key = yield* Effect.try({
        try: () => createPublicKey(pem),
        catch: (cause) => new Cryptography.InvalidPublicKey({ cause })
      });
      const details = key.asymmetricKeyDetails;
      if (
        key.asymmetricKeyType !== "rsa" ||
        details?.modulusLength === undefined ||
        details.publicExponent === undefined
      )
        return yield* new Cryptography.InvalidPublicKey({});
      return {
        modulusLength: details.modulusLength,
        publicExponent: details.publicExponent,
        spki: key.export({ type: "spki", format: "pem" }).toString()
      };
    })
});

export const layer = Layer.succeed(Cryptography.Cryptography, make);
