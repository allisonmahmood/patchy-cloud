import { PostHogSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

const metadata = {
  schema: PostHogSnapshot,
  discover: Effect.fn("PostHog.metadata.discover")(function* (
    credentials: typeof Source.Credentials.Type
  ) {
    const source = yield* Source.Source;
    return (yield* source.inspect(Source.credentials(credentials))).snapshot;
  })
};

// Keep declaration emission pointed at the operation module's public types.
export const posthog: {
  readonly name: "posthog";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
} = defineIntegration({
  name: "posthog",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata,
  operations,
  generate
});
