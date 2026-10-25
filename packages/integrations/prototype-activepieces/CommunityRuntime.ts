/** Local-only implementation of generation, publish binding and credential-free runtime calls. */
import { CommunityCall, CommunityResult, type CommunityDeclaration } from "@patchy/api";
import * as CommunitySupport from "../src/CommunitySupport.js";
import * as ConnectionStore from "../src/ConnectionStore.js";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as Pieces from "./Pieces.js";
import { definition, isKey, type Key } from "./catalog.js";

type Declaration = typeof CommunityDeclaration.Type;
const Row = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  status: Schema.String,
  credentials: Schema.String,
  keyId: Schema.String,
  credentialRevision: Schema.Int,
  revision: Schema.Int,
  credentialFormat: Schema.NullOr(Schema.String)
});
const rows = Schema.decodeUnknownEffect(Schema.Array(Row));
const json = Schema.decodeUnknownEffect(Schema.Json);
const missing = (companyId: string, id: string) =>
  new ConnectionStore.ConnectionNotFound({ companyId, lookup: { id } });

/** Generated from the admitted module fields; the transport, alias and identity belong to Patchy. */
export const generateClient = (info: Pieces.Info, actions: ReadonlyArray<string>) => {
  const selected = info.actions.filter((action) => actions.includes(action.name));
  const args = (fields: Pieces.Info["fields"]) =>
    `{ ${fields.map((field) => `readonly ${JSON.stringify(field.name)}${field.required ? "" : "?"}: string`).join("; ")} }`;
  return `// Generated from a pinned community module. No credentials or provider HTTP code.
import { PatchyError, decodeError } from "patchy/client";
import type { Call } from "patchy/client";
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export interface Client {
${selected.map((action) => `  ${JSON.stringify(action.name)}(inputs: ${args(action.fields)}): Promise<Json>;`).join("\n")}
}
export function createClient(connection: string, call: Call): Client {
  const run = async (action: string, inputs: Readonly<Record<string, string | undefined>>): Promise<Json> => {
    const value = await call("community.call", { connection, action, inputs });
    const error = decodeError(value, "community.call");
    if (error) throw error;
    if (value === null || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("value" in value))
      throw new PatchyError("invalid_request", "The community transport returned an invalid response.", {});
    return value.value as Json;
  };
  return {
${selected.map((action) => `    ${JSON.stringify(action.name)}: (inputs) => run(${JSON.stringify(action.name)}, inputs)`).join(",\n")}
  };
}
`;
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pieces = yield* Pieces.Pieces;
  const keys = yield* CredentialKeys.CredentialKeys;
  const load = Effect.fn("CommunityRuntime.load")(function* (
    companyId: string,
    piece: Key,
    handle: string
  ) {
    const found = yield* sql`SELECT id, handle, status, credentials, key_id AS "keyId",
      credential_revision AS "credentialRevision", metadata_revision AS revision,
      display->>'credentialFormat' AS "credentialFormat"
      FROM connections WHERE company_id = ${companyId} AND integration = ${`activepieces:${piece}`} AND handle = ${handle}
      FOR SHARE`.pipe(Effect.flatMap(rows), Effect.catchTags({ SchemaError: Effect.die }));
    if (!found[0]) return yield* missing(companyId, handle);
    if (found[0].status !== "connected")
      return yield* new ConnectionStore.ConnectionNotConnected({});
    return found[0];
  });
  const admitted = (declaration: Pick<Declaration, "piece" | "version" | "actions">) => {
    if (
      !isKey(declaration.piece) ||
      declaration.version !== definition(declaration.piece).version ||
      new Set(declaration.actions).size !== declaration.actions.length ||
      declaration.actions.length === 0
    )
      return false;
    return declaration.actions.every((action) =>
      Object.hasOwn(definition(declaration.piece as Key).actions, action)
    );
  };
  const resolve: CommunitySupport.Support["resolve"] = Effect.fn("CommunityRuntime.resolve")(
    function* (companyId: string, declaration: Parameters<CommunitySupport.Support["resolve"]>[1]) {
      if (!admitted(declaration)) return yield* missing(companyId, declaration.handle);
      const row = yield* load(companyId, declaration.piece as Key, declaration.handle);
      const info = pieces.infos.find((info) => info.key === declaration.piece)!;
      return {
        id: row.id,
        revision: row.revision,
        client: generateClient(info, declaration.actions),
        context: `# Community connection\n\nPinned module: ${definition(info.key).package}@${declaration.version}.\nActions: ${declaration.actions.join(", ")}.\nCalls run as the active company viewer through Patchy. Credentials remain server-side. This local prototype supports published company tier 1 pages only; patchy dev and tier 2 callbacks are not wired.\n`
      };
    }
  );
  const validate: CommunitySupport.Support["validate"] = Effect.fn("CommunityRuntime.validate")(
    function* (companyId: string, declaration: Declaration) {
      if (!admitted(declaration)) return yield* missing(companyId, declaration.id);
      const row = yield* load(companyId, declaration.piece as Key, declaration.handle);
      if (row.id !== declaration.id || row.revision !== declaration.revision)
        return yield* missing(companyId, declaration.id);
    }
  );
  const handler = Runtime.handler(
    {
      kind: "integration",
      input: CommunityCall,
      output: CommunityResult,
      resource: (args) =>
        Predicate.isObject(args) && typeof args.action === "string"
          ? args.action.slice(0, 100)
          : null,
      connectionId: (args, binding) => {
        if (
          !Predicate.isObject(args) ||
          typeof args.connection !== "string" ||
          !Object.hasOwn(binding.manifest.uses, args.connection)
        )
          return null;
        const declaration = binding.manifest.uses[args.connection];
        return declaration?.kind === "community" ? declaration.id : null;
      }
    },
    Effect.fn("CommunityRuntime.call")(function* (args) {
      const binding = yield* Binding.Binding;
      if (
        binding.scope !== "company" ||
        binding.manifest.tier !== 1 ||
        binding.identity === null ||
        binding.principal === null ||
        binding.identity.company.id !== binding.companyId ||
        binding.identity.user.id !== binding.principal.userId
      )
        return yield* new Runtime.AccessDenied({});
      const declaration = Object.hasOwn(binding.manifest.uses, args.connection)
        ? binding.manifest.uses[args.connection]
        : undefined;
      if (
        declaration?.kind !== "community" ||
        !admitted(declaration) ||
        !declaration.actions.includes(args.action)
      )
        return yield* new Runtime.AccessDenied({});
      const piece = declaration.piece as Key;
      const action = pieces.infos
        .find((info) => info.key === piece)!
        .actions.find((action) => action.name === args.action)!;
      if (!Pieces.validInputs(action.fields, args.inputs))
        return yield* new Runtime.InvalidRequest({});
      return yield* Effect.gen(function* () {
        yield* validate(binding.companyId, declaration);
        const before = yield* load(binding.companyId, piece, declaration.handle);
        const secret = yield* keys.decrypt(
          {
            companyId: binding.companyId,
            id: declaration.id,
            integration: `activepieces:${piece}`
          },
          before
        );
        const credentials =
          before.credentialFormat === "1"
            ? yield* Pieces.decodeCredentials(Redacted.value(secret)).pipe(
                Effect.map(Redacted.make)
              )
            : Redacted.make({ [definition(piece).legacyCredentialField!]: Redacted.value(secret) });
        const value = yield* pieces.run(piece, args.action, credentials, args.inputs);
        const after = yield* load(binding.companyId, piece, declaration.handle);
        if (after.id !== before.id || after.credentialRevision !== before.credentialRevision)
          return yield* new Runtime.AccessDenied({});
        return { ok: true as const, value: yield* json(value) };
      }).pipe(
        Effect.catchTags({
          ConnectionNotFound: () => Effect.fail(new Runtime.AccessDenied({})),
          ConnectionNotConnected: () => Effect.fail(new Runtime.AccessDenied({})),
          CredentialDecryptionFailed: (cause) =>
            Effect.fail(new Runtime.SourceUnavailable({ cause })),
          PieceFailure: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          SchemaError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
        })
      );
    })
  );
  return {
    resolve,
    validate,
    handlers: { "community.call": handler }
  } satisfies CommunitySupport.Support;
});
export const layer = Layer.effect(CommunitySupport.CommunitySupport, make);
