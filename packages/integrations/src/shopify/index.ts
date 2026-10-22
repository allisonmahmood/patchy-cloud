import { ShopifySnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

const metadata = {
  schema: ShopifySnapshot,
  discover: Effect.fn("Shopify.metadata.discover")(function* (
    credentials: typeof Source.Credentials.Type
  ) {
    const source = yield* Source.Source;
    return (yield* source.inspect(Source.credentials(credentials))).snapshot;
  })
};

/** PROTOTYPE (#815). */
export const shopify: {
  readonly name: "shopify";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly live?: ReadonlyArray<keyof typeof operations>;
} = defineIntegration({
  name: "shopify",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata,
  operations,
  generate,
  // Its search, sorting and reports can't run locally, and it can't write: dev reads the store.
  live: ["read"]
});
