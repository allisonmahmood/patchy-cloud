import { AttioSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import * as Source from "./Source.js";

const metadata = {
  schema: AttioSnapshot,
  discover: Effect.fn("Attio.metadata.discover")(function* (credentials: Source.Credentials) {
    const source = yield* Source.Source;
    return (yield* source.inspect(Redacted.make(credentials.key))).snapshot;
  })
};

// Reads arrive with #966; until then a declaration generates an empty client and its context.
const operations = {};

// Keep declaration emission pointed at the operation module's public types.
export const attio: {
  readonly name: "attio";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly live?: ReadonlyArray<keyof typeof operations>;
} = defineIntegration({
  name: "attio",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata,
  operations,
  generate,
  // Hand-written CRM rows wouldn't resemble a company's: dev reads the real workspace.
  live: []
});
