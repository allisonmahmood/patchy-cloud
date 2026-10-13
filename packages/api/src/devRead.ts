import * as Schema from "effect/Schema";
import { PostHogDevQuery } from "./posthog.js";

/** Where `patchy dev` sends a read, under the instance's `/api`. */
export const DEV_READ_PATH = "/connections/dev-read";

/**
 * A `patchy dev` read of an integration that dev reads live (#647). The repo's manifest only
 * routed it to this connection: the machine token decides the company and the person, and the
 * instance checks the connection itself.
 */
const DevReadConnection = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  handle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
});

/** What the instance reads before logging the call, so a refused operation or argument is logged too. */
export const DevReadEnvelope = Schema.Struct({
  op: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,31}\.[A-Za-z]{1,32}$/)),
  connection: DevReadConnection,
  args: Schema.Unknown
}).annotate({ identifier: "DevReadEnvelope" });
export type DevReadEnvelope = typeof DevReadEnvelope.Type;

/** Every operation an integration lets dev read live, with its exact arguments. */
export const DevRead = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("posthog.query"),
    connection: DevReadConnection,
    args: PostHogDevQuery
  })
]).annotate({ identifier: "DevRead" });
export type DevRead = typeof DevRead.Type;
