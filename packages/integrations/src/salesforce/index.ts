import { SalesforceSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Nango from "../Nango.js";
import { defineIntegration } from "../definition.js";
import { operations } from "./Operations.js";
import { generate } from "./Generate.js";
import * as Source from "./Source.js";
const metadata = {
  schema: SalesforceSnapshot,
  discover: (mapping: Nango.Mapping): Effect.Effect<typeof SalesforceSnapshot.Type, Nango.Failed> =>
    Source.inspect(Source.credentials(mapping)).pipe(Effect.map((result) => result.snapshot))
};
export const salesforce: {
  readonly name: "salesforce";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Nango.Mapping;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly live?: ReadonlyArray<keyof typeof operations>;
} = defineIntegration({
  name: "salesforce",
  modes: ["company"],
  credentials: Nango.Mapping,
  metadata,
  operations,
  generate,
  live: ["query", "describe"]
});
