import { ModelsSnapshot } from "@patchy/api";
import type { ModelsSnapshot as Snapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

/**
 * Model roles. A role is a connection of this integration, mapped to a provider connection
 * (`openai`) and a model; patches declare roles. A role's snapshot is only its kind: where it
 * points lives on the connection, so a remap needs no republish. PROTOTYPE: roles are seeded, so
 * discovery only reads the kind back.
 */
const metadata = {
  schema: ModelsSnapshot,
  discover: Effect.fn("Models.metadata.discover")(function* (
    _credentials: typeof Source.RoleCredentials.Type
  ): Effect.fn.Return<Snapshot> {
    return yield* Effect.die("A model role is seeded, never discovered, in this prototype.");
  })
};

// Keep declaration emission pointed at the operation module's public types.
export const models: {
  readonly name: "models";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.RoleCredentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
} = defineIntegration({
  name: "models",
  modes: ["company"],
  credentials: Source.RoleCredentials,
  metadata,
  operations,
  generate
});
