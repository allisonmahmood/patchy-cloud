/**
 * What Patchy keeps about one Pidgeon inbox when it connects: the address, what patches may do
 * with it, whether the stored key is a test key, and the inbox's labels. Never a message.
 */
import * as Schema from "effect/Schema";
import { registry } from "@patchy/limits/registry";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const PidgeonLabel = Schema.Struct({
  id: Text(128),
  name: Text(200),
  colour: Text(32)
});

/**
 * One inbox and its labels. `access` is Patchy's own setting for the connection: `read` reads
 * its mail; `send` also replies, sends and triages from it. `test` marks a connection whose key
 * is a Pidgeon test key: the mail it sends stays in Pidgeon.
 */
export const PidgeonSnapshot = Schema.Struct({
  version: Schema.Literal(2),
  address: Schema.Struct({
    email: Text(320),
    displayName: Schema.NullOr(Text(200))
  }),
  access: Schema.Literals(["read", "send"]),
  test: Schema.Boolean,
  labels: Schema.Array(PidgeonLabel)
}).check(
  Schema.makeFilter(
    (snapshot) =>
      snapshot.labels.length <= registry["pidgeon.snapshot.labels"].default ||
      `A Pidgeon snapshot keeps at most ${registry["pidgeon.snapshot.labels"].default} labels.`
  )
);
export type PidgeonSnapshot = typeof PidgeonSnapshot.Type;
