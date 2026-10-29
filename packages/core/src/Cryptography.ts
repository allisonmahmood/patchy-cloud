/**
 * Patchy's cryptography: its id, token and digest formats, and the keyed operations Effect's own
 * `Crypto` lacks (HMAC, HKDF, AES-256-GCM, constant-time comparison, public-key inspection).
 * Services take it from the environment at construction; `NodeCryptography.layer` implements it,
 * and is the one place production code reaches `node:crypto`.
 */
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class SealFailed extends Schema.TaggedError<SealFailed>()("SealFailed", {
  cause: Schema.Defect()
}) {
  override get message() {
    return "The value could not be sealed.";
  }
}

/** Nothing about why: a wrong key, a wrong context and a tampered value look the same. */
export class OpenFailed extends Schema.TaggedError<OpenFailed>()("OpenFailed", {}) {
  override get message() {
    return "The sealed value could not be opened.";
  }
}

export class InvalidPublicKey extends Schema.TaggedError<InvalidPublicKey>()("InvalidPublicKey", {
  cause: Schema.optional(Schema.Defect())
}) {
  override get message() {
    return "The value is not an RSA public key.";
  }
}

export class Cryptography extends Context.Service<
  Cryptography,
  {
    readonly randomBytes: (size: number) => Effect.Effect<Uint8Array>;
    /** `length` characters drawn uniformly from `alphabet`, which holds at most 256. */
    readonly randomString: (alphabet: string, length: number) => Effect.Effect<string>;
    /** A version 4 UUID, lowercase and hyphenated. */
    readonly randomUUID: Effect.Effect<string>;
    /** A patch id: 12 characters of `[a-z0-9]`. */
    readonly patchId: Effect.Effect<string>;
    /** `${prefix}_` and 24 characters of `[a-z0-9]`. */
    readonly internalId: (prefix: string) => Effect.Effect<string>;
    /** `bytes` random bytes (32 by default) as unpadded base64url. */
    readonly token: (bytes?: number) => Effect.Effect<string>;
    readonly digest: (
      algorithm: Exclude<Crypto.DigestAlgorithm, "SHA-384">,
      data: string | Uint8Array
    ) => Effect.Effect<Uint8Array>;
    /** SHA-256 as lowercase hex. Strings hash as UTF-8. */
    readonly sha256: (data: string | Uint8Array) => Effect.Effect<string>;
    /**
     * SHA-256 for a synchronous section that must not yield, such as a commit applied in one
     * step. Everywhere else, `sha256`.
     */
    readonly sha256Unsafe: (data: string | Uint8Array, encoding: "hex" | "base64") => string;
    readonly hmacSha256: (
      key: string | Uint8Array,
      data: string | Uint8Array
    ) => Effect.Effect<Uint8Array>;
    /** Whether `a` and `b` hold the same bytes, in time that depends only on their lengths. */
    readonly equal: (a: Uint8Array, b: Uint8Array) => Effect.Effect<boolean>;
    readonly hkdfSha256: (
      secret: string | Uint8Array,
      salt: string | Uint8Array,
      info: string,
      length: number
    ) => Effect.Effect<Uint8Array>;
    /**
     * AES-256-GCM under a 32-byte `key`, bound to `context`: base64 of a fresh 12-byte nonce,
     * the 16-byte tag and the ciphertext.
     */
    readonly seal: (
      key: Uint8Array,
      plaintext: string,
      context: string
    ) => Effect.Effect<string, SealFailed>;
    /** The plaintext `seal` made under the same key and context. */
    readonly open: (
      key: Uint8Array,
      sealed: string,
      context: string
    ) => Effect.Effect<string, OpenFailed>;
    /** An RSA public key from PEM (SPKI or PKCS#1): its size, exponent and SPKI PEM. */
    readonly rsaPublicKey: (pem: string) => Effect.Effect<
      {
        readonly modulusLength: number;
        readonly publicExponent: bigint;
        readonly spki: string;
      },
      InvalidPublicKey
    >;
  }
>()("@patchy/core/Cryptography") {}
