import { PidgeonSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import * as Keys from "./Keys.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

const metadata = {
  schema: PidgeonSnapshot,
  discover: Effect.fn("Pidgeon.metadata.discover")(function* (credentials: Source.Credentials) {
    const reach = yield* Keys.test(credentials, credentials.identityId);
    const access = reach.me.key?.access === "send" ? "send" : "read";
    return (yield* Keys.inspect(credentials, credentials.identityId, access)).snapshot;
  })
};

// Keep declaration emission pointed at the operation module's public types.
export const pidgeon: {
  readonly name: "pidgeon";
  readonly modes: readonly ["company"];
  readonly credentials: typeof Source.Credentials;
  readonly metadata?: typeof metadata;
  readonly operations: typeof operations;
  readonly generate: typeof generate;
  readonly live?: ReadonlyArray<keyof typeof operations>;
} = defineIntegration({
  name: "pidgeon",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata,
  operations,
  generate,
  // Mail a builder's agent invents never resembles a company's: dev reads the real address. Its
  // writes never run live in dev; `patchy dev` simulates them.
  live: ["read"]
});
