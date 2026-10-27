/**
 * What Patchy keeps about one Pidgeon address when it connects: the address, who it may write
 * to, what Patchy's key for it may do, whether it's in test mode, its labels and the account's
 * plan. Never a message.
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
 * One address and its labels. `access` is what Patchy's own key for it may do: `read` reads its
 * mail; `send` also replies, sends and triages from it. `sendPolicy` is Pidgeon's, such as
 * `reply_only`, which can't start a conversation with a stranger, `open` or `list`. `test` marks
 * a test address: its mail stays in Pidgeon, and Pidgeon deletes it a day after it was made.
 */
export const PidgeonSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  address: Schema.Struct({
    email: Text(320),
    displayName: Schema.NullOr(Text(200)),
    sendPolicy: Text(32)
  }),
  access: Schema.Literals(["read", "send"]),
  test: Schema.Boolean,
  labels: Schema.Array(PidgeonLabel),
  plan: Text(64)
}).check(
  Schema.makeFilter(
    (snapshot) =>
      snapshot.labels.length <= registry["pidgeon.snapshot.labels"].default ||
      `A Pidgeon snapshot keeps at most ${registry["pidgeon.snapshot.labels"].default} labels.`
  )
);
export type PidgeonSnapshot = typeof PidgeonSnapshot.Type;
