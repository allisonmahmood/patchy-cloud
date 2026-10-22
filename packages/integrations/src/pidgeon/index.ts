import { PidgeonSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

const metadata = {
  schema: PidgeonSnapshot,
  discover: Effect.fn("Pidgeon.metadata.discover")(function* (
    credentials: typeof Source.Credentials.Type
  ) {
    const source = yield* Source.Source;
    return (yield* source.inspect(Source.credentials(credentials))).snapshot;
  })
};

/** PROTOTYPE (Pidgeon). It sends mail, so dev never reads the real address: no `live`. */
export const pidgeon: {
  readonly name: "pidgeon";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
} = defineIntegration({
  name: "pidgeon",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata,
  operations,
  generate
});
