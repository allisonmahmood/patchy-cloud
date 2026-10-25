/** Shared server-only loader; no provider HTTP operations or bespoke connection forms. */
import { createRequire } from "node:module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type AuthField, loadPiece } from "./adapter.js";
import { catalog, definition, type Key } from "./catalog.js";

export const Credentials = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isMaxLength(4096))
);
export type Credentials = typeof Credentials.Type;
export const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));
export interface Info {
  readonly key: Key;
  readonly displayName: string;
  readonly authDescription: string;
  readonly fields: ReadonlyArray<AuthField>;
  readonly actions: ReadonlyArray<{ readonly name: string; readonly displayName: string }>;
}
export class PieceFailure extends Schema.TaggedError<PieceFailure>()("PieceFailure", {
  key: Schema.String,
  stage: Schema.Literals(["load", "validate", "run"]),
  cause: Schema.optional(Schema.Redacted(Schema.Defect()))
}) {
  override get message() {
    return `The ${this.key} connector could not ${this.stage === "validate" ? "validate the credentials" : this.stage === "run" ? "complete the action" : "load"}. Check the setup instructions and required permissions.`;
  }
}
export class Pieces extends Context.Service<
  Pieces,
  {
    readonly infos: ReadonlyArray<Info>;
    readonly validate: (
      key: Key,
      credentials: Redacted.Redacted<Credentials>
    ) => Effect.Effect<boolean, PieceFailure>;
    readonly run: (
      key: Key,
      action: string,
      credentials: Redacted.Redacted<Credentials>
    ) => Effect.Effect<unknown, PieceFailure>;
  }
>()("prototype/activepieces/Pieces") {}

export const makeWithTestPreload = Effect.fn("Pieces.make")(function* (testPreload?: string) {
  const require = createRequire(import.meta.url);
  const loaded = new Map<Key, { piece: Awaited<ReturnType<typeof loadPiece>>; info: Info }>();
  for (const key of Object.keys(catalog) as Key[]) {
    const entry = definition(key);
    const piece = yield* Effect.tryPromise({
      try: () => {
        const installed: { version?: unknown } = require(`${entry.package}/package.json`);
        if (installed.version !== entry.version)
          throw new Error("Installed piece differs from the reviewed version");
        return loadPiece(
          {
            modulePath: require.resolve(entry.package),
            exportName: entry.exportName,
            authType: entry.authType
          },
          Object.keys(entry.actions),
          testPreload
        );
      },
      catch: (cause) => new PieceFailure({ key, stage: "load", cause: Redacted.make(cause) })
    });
    const fields = entry.authFields
      ? entry.authFields.map((name) =>
          piece.metadata.authFields.find((field) => field.name === name)
        )
      : piece.metadata.authFields;
    if (
      !piece.metadata.hasValidator ||
      fields.some((field) => !field || !["SECRET_TEXT", "SHORT_TEXT"].includes(field.type)) ||
      piece.metadata.authFields.some(
        (field) => field.required && !fields.some((selected) => selected?.name === field.name)
      )
    )
      return yield* new PieceFailure({ key, stage: "load" });
    const info: Info = {
      key,
      displayName: piece.metadata.displayName,
      authDescription: piece.metadata.authDescription,
      fields: fields as ReadonlyArray<AuthField>,
      actions: piece.metadata.actionDetails.filter((action) =>
        Object.hasOwn(entry.actions, action.name)
      )
    };
    loaded.set(key, { piece, info });
  }

  const credentialsValid = (key: Key, credentials: Credentials) => {
    const { fields } = loaded.get(key)!.info;
    return (
      Object.keys(credentials).every((name) => fields.some((field) => field.name === name)) &&
      fields.every((field) => !field.required || (credentials[field.name]?.trim().length ?? 0) > 0)
    );
  };
  const validationAuth = (key: Key, credentials: Credentials) =>
    definition(key).authType === "SECRET_TEXT" ? credentials.secret_text : credentials;
  const actionAuth = (key: Key, credentials: Credentials) =>
    definition(key).authType === "SECRET_TEXT"
      ? { type: "SECRET_TEXT", secret_text: credentials.secret_text }
      : { type: "CUSTOM_AUTH", props: credentials };

  return Pieces.of({
    infos: [...loaded.values()].map(({ info }) => info),
    validate: (key, credentials) => {
      const values = Redacted.value(credentials);
      if (!credentialsValid(key, values)) return Effect.succeed(false);
      return Effect.tryPromise({
        try: () => loaded.get(key)!.piece.validate(validationAuth(key, values)),
        catch: (cause) => new PieceFailure({ key, stage: "validate", cause: Redacted.make(cause) })
      });
    },
    run: (key, action, credentials) =>
      Effect.tryPromise({
        try: async () => {
          const values = Redacted.value(credentials);
          if (!credentialsValid(key, values) || !Object.hasOwn(definition(key).actions, action))
            throw new Error("Action or credentials not admitted");
          const value = await loaded
            .get(key)!
            .piece.run(action, actionAuth(key, values), definition(key).actions[action]!);
          // Redact encoded secret strings even if a reviewed connector reflects them in object keys.
          let encoded = JSON.stringify(value);
          for (const field of loaded
            .get(key)!
            .info.fields.filter((field) => field.type === "SECRET_TEXT")) {
            const secret = values[field.name];
            if (secret)
              encoded = encoded.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
          }
          return JSON.parse(encoded);
        },
        catch: (cause) => new PieceFailure({ key, stage: "run", cause: Redacted.make(cause) })
      })
  });
});
export const make = makeWithTestPreload();
export const layer = Layer.effect(Pieces, make);
