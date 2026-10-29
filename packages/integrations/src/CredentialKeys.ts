import type { Integration } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export class InvalidCredentialKeys extends Schema.TaggedError<InvalidCredentialKeys>()(
  "InvalidCredentialKeys",
  { entry: Schema.Int }
) {
  readonly code = "invalid_credential_keys";
  readonly status = 500;
  override get message() {
    return "PATCHY_CREDENTIAL_KEYS must be a comma-separated list of unique key ids and canonical base64-encoded 32-byte keys; the first key is active.";
  }
}

export class CredentialEncryptionFailed extends Schema.TaggedError<CredentialEncryptionFailed>()(
  "CredentialEncryptionFailed",
  { cause: Schema.Redacted(Schema.Defect()) }
) {
  readonly code = "credential_encryption_failed";
  readonly status = 500;
  override get message() {
    return "The connection credentials could not be encrypted.";
  }
}

export class CredentialDecryptionFailed extends Schema.TaggedError<CredentialDecryptionFailed>()(
  "CredentialDecryptionFailed",
  {}
) {
  readonly code = "credential_decryption_failed";
  readonly status = 503;
  override get message() {
    return "The connection credentials are unavailable. Ask an administrator to check the credential keyring or rotate the credentials.";
  }
}

export type CredentialError = CredentialEncryptionFailed | CredentialDecryptionFailed;

export interface Identity {
  readonly companyId: string;
  readonly id: string;
  readonly integration: Integration;
}

export interface EncryptedCredentials {
  readonly keyId: string;
  readonly credentials: string;
}

export class CredentialKeys extends Context.Service<
  CredentialKeys,
  {
    readonly encrypt: (
      identity: Identity,
      credentials: Redacted.Redacted<string>
    ) => Effect.Effect<EncryptedCredentials, CredentialEncryptionFailed>;
    readonly decrypt: (
      identity: Identity,
      encrypted: EncryptedCredentials
    ) => Effect.Effect<Redacted.Redacted<string>, CredentialDecryptionFailed>;
  }
>()("@patchy/integrations/CredentialKeys") {}

const KeyEntry = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9+/]{43}=$/));
const isKeyEntry = Schema.is(KeyEntry);
const isBase64 = Schema.is(
  Schema.String.check(
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  )
);
const associatedData = (identity: Identity, keyId: string) =>
  JSON.stringify([identity.companyId, identity.id, identity.integration, keyId]);

const parseKeys = Effect.fn("CredentialKeys.parseKeys")(function* (
  configuration: Redacted.Redacted<string>
) {
  const entries = Redacted.value(configuration).split(",");
  const keys = new Map<string, Buffer>();
  let activeId = "";
  for (const [index, entry] of entries.entries()) {
    if (!isKeyEntry(entry)) return yield* new InvalidCredentialKeys({ entry: index + 1 });
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    const key = Buffer.from(encoded, "base64");
    if (keys.has(id) || key.length !== 32 || key.toString("base64") !== encoded) {
      return yield* new InvalidCredentialKeys({ entry: index + 1 });
    }
    if (index === 0) activeId = id;
    keys.set(id, key);
  }
  return { keys, activeId };
});

/** The explicit configuration seam also exercises old-key rotation without process environment changes. */
export const makeFromKeys = Effect.fn("CredentialKeys.makeFromKeys")(function* (
  configuration: Redacted.Redacted<string>
) {
  const { keys, activeId } = yield* parseKeys(configuration);
  const activeKey = keys.get(activeId)!;

  const cryptography = yield* Cryptography.Cryptography;

  const encrypt = Effect.fn("CredentialKeys.encrypt")(
    (identity: Identity, credentials: Redacted.Redacted<string>) =>
      cryptography
        .seal(activeKey, Redacted.value(credentials), associatedData(identity, activeId))
        .pipe(
          Effect.map((sealed) => ({ keyId: activeId, credentials: sealed })),
          Effect.mapError(
            (cause) => new CredentialEncryptionFailed({ cause: Redacted.make(cause) })
          )
        )
  );

  const decrypt = Effect.fn("CredentialKeys.decrypt")(function* (
    identity: Identity,
    encrypted: EncryptedCredentials
  ) {
    const key = keys.get(encrypted.keyId);
    if (
      key === undefined ||
      !isBase64(encrypted.credentials) ||
      Buffer.from(encrypted.credentials, "base64").toString("base64") !== encrypted.credentials
    )
      return yield* new CredentialDecryptionFailed({});
    // Authentication failures deliberately do not retain crypto implementation diagnostics.
    return yield* cryptography
      .open(key, encrypted.credentials, associatedData(identity, encrypted.keyId))
      .pipe(
        Effect.map(Redacted.make),
        Effect.catchTags({ OpenFailed: () => Effect.fail(new CredentialDecryptionFailed({})) })
      );
  });

  return CredentialKeys.of({ encrypt, decrypt });
});

export const config = Config.Redacted("PATCHY_CREDENTIAL_KEYS").pipe(
  Config.mapEffect((value) =>
    parseKeys(value).pipe(
      Effect.as(value),
      Effect.mapError(
        (error) =>
          new Config.ConfigError(
            new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: error.message }, value))
          )
      )
    )
  )
);

export const make = Effect.gen(function* () {
  return yield* makeFromKeys(yield* config);
});

export const layer = Layer.effect(CredentialKeys, make);
export const layerFromKeys = (configuration: Redacted.Redacted<string>) =>
  Layer.effect(CredentialKeys, makeFromKeys(configuration));
