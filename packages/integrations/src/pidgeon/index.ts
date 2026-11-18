import { PidgeonSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import { defineIntegration } from "../definition.js";
import { generate } from "./Generate.js";
import * as Keys from "./Keys.js";
import { operations } from "./Operations.js";
import * as Source from "./Source.js";

const metadata = {
  schema: PidgeonSnapshot,
  /**
   * A snapshot read with the credentials alone, at Read. What patches may do is the connection's
   * own setting, which the store's paths pass instead.
   */
  discover: Effect.fn("Pidgeon.metadata.discover")(function* (credentials: Source.Credentials) {
    const display: Source.Display = {
      email: credentials.inboxId,
      inboxId: credentials.inboxId,
      access: "read",
      test: Source.isTestToken(credentials.key)
    };
    return (yield* Keys.inspect(credentials, display, "read")).snapshot;
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
  // Mail a builder's agent invents never resembles a company's: dev reads the real inbox. Its
  // writes never run live in dev; `patchy dev` simulates them.
  live: ["read"]
});
