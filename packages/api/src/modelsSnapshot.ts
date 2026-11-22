/**
 * What Patchy keeps about one model role, a connection of the `models` integration: only its
 * kind, which never changes. Its provider and model can be remapped at any time and are never
 * part of a snapshot, so a patch published against a role follows a remap from its next call.
 */
import * as Schema from "effect/Schema";

/** What a model role does: a decision role answers fixed questions, a text role writes. */
export const modelRoleKinds = ["decision", "text"] as const;
export const ModelRoleKind = Schema.Literals(modelRoleKinds);
export type ModelRoleKind = typeof ModelRoleKind.Type;

export const ModelsSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  kind: ModelRoleKind
});
export type ModelsSnapshot = typeof ModelsSnapshot.Type;
