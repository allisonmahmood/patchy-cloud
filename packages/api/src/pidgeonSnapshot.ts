/** PROTOTYPE (Pidgeon): what connect keeps about the address; apart from schemas.ts, which imports it. */
import * as Schema from "effect/Schema";

export const PidgeonLabel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  colour: Schema.String
});

/**
 * One address and what the key may do with it, never a message. `access` is the key's ceiling:
 * `read` patches can list and read; `send` patches can also reply, send and triage.
 */
export const PidgeonSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  address: Schema.Struct({
    email: Schema.String,
    displayName: Schema.NullOr(Schema.String),
    /** Who it may write to: open, reply_only (people who wrote first) or list. */
    sendPolicy: Schema.String
  }),
  access: Schema.Literals(["read", "send"]),
  labels: Schema.Array(PidgeonLabel),
  plan: Schema.String
});
export type PidgeonSnapshot = typeof PidgeonSnapshot.Type;
