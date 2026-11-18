import * as Schema from "effect/Schema";

/** What a model role does: a decision role answers fixed questions, a text role writes. */
export const ModelRoleKind = Schema.Literals(["decision", "text"]);
export type ModelRoleKind = typeof ModelRoleKind.Type;

/** A role's snapshot: only its kind, which generation types the client by and never changes. */
export const ModelsSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  kind: ModelRoleKind
});
export type ModelsSnapshot = typeof ModelsSnapshot.Type;

/** A model provider connection's snapshot holds nothing patches read. */
export const OpenAiSnapshot = Schema.Struct({ version: Schema.Literal(1) });
export type OpenAiSnapshot = typeof OpenAiSnapshot.Type;
