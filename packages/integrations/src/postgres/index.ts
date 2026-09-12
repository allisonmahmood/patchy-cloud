import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Source from "./Source.js";
import { operations } from "./Operations.js";
import { generate } from "./Generate.js";
import { dev } from "./Dev.js";

const metadata = {
  schema: Snapshot,
  discover: Effect.fn("Postgres.metadata.discover")(function* (
    credentials: typeof Source.Credentials.Type
  ) {
    const source = yield* Source.Source;
    return (yield* source.inspect(credentials)).snapshot;
  })
};

// Keep declaration emission pointed at the operation module's public types.
export const postgres: {
  readonly name: "postgres";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly dev: typeof dev;
} = defineIntegration({
  name: "postgres",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata,
  operations,
  generate,
  dev
});
