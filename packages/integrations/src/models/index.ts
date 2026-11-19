import { ModelsSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

/**
 * Model roles. A role is a connection of this integration, mapped to a provider connection
 * (`openai`) and a model; patches declare roles. A role's snapshot is only its kind: where it
 * points lives on the connection, so a remap needs no republish. `patchy dev` calls a role for real
 * through the instance's dev door (ADR-0013): a fake model would never answer like the company's.
 * PROTOTYPE: roles are seeded, so nothing discovers one.
 */
const metadata = {
  schema: ModelsSnapshot,
  discover: (): Effect.Effect<typeof ModelsSnapshot.Type> =>
    Effect.die("A model role is seeded, never discovered, in this prototype.")
};

// Keep declaration emission pointed at the operation module's public types.
export const models: {
  readonly name: "models";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.RoleCredentials;
  readonly metadata?: {
    readonly schema: typeof ModelsSnapshot;
    readonly discover: (
      credentials: typeof Source.RoleCredentials.Type
    ) => Effect.Effect<typeof ModelsSnapshot.Type>;
  };
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly live?: ReadonlyArray<keyof typeof operations>;
} = defineIntegration({
  name: "models",
  modes: ["company"],
  credentials: Source.RoleCredentials,
  metadata,
  operations,
  generate,
  live: ["decide", "generate"]
});
