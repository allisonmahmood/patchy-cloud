/** Host-reviewed catalog entries. No provider HTTP implementation lives here. */
import { createRequire } from "node:module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { loadPiece } from "./adapter.js";

export const catalog = {
  slack: {
    label: "Slack",
    version: "0.23.1",
    action: "slack_list_channels",
    actionLabel: "List public channels",
    credentialField: "botToken",
    props: { types: "public_channel", excludeArchived: true }
  }
} as const;
export type Key = keyof typeof catalog;

export class PieceFailure extends Schema.TaggedError<PieceFailure>()("PieceFailure", {}) {
  override get message() {
    return "Slack did not complete the request. Check that the bot token is valid and has channels:read, then try again.";
  }
}

export class Pieces extends Context.Service<
  Pieces,
  {
    readonly validate: (
      key: Key,
      token: Redacted.Redacted<string>
    ) => Effect.Effect<boolean, PieceFailure>;
    readonly run: (
      key: Key,
      token: Redacted.Redacted<string>
    ) => Effect.Effect<unknown, PieceFailure>;
  }
>()("prototype/activepieces/Pieces") {}

export const makeWithTestPreload = (testPreload?: string) =>
  Effect.gen(function* () {
    const require = createRequire(import.meta.url);
    const piece = yield* Effect.tryPromise({
      try: () =>
        loadPiece(
          {
            modulePath: require.resolve("@activepieces/piece-slack"),
            exportName: "slack",
            authType: "CUSTOM_AUTH"
          },
          [catalog.slack.action],
          testPreload
        ),
      catch: () => new PieceFailure({})
    });
    return Pieces.of({
      validate: (key, token) =>
        Effect.tryPromise({
          try: () => piece.validate({ [catalog[key].credentialField]: Redacted.value(token) }),
          catch: () => new PieceFailure({})
        }),
      run: (key, token) =>
        Effect.tryPromise({
          try: async () => {
            const value = await piece.run(
              catalog[key].action,
              {
                type: "CUSTOM_AUTH",
                props: { [catalog[key].credentialField]: Redacted.value(token) }
              },
              catalog[key].props
            );
            // A connector must not reflect its input credential through an output or error.
            return JSON.parse(
              JSON.stringify(value).split(Redacted.value(token)).join("[redacted]")
            );
          },
          catch: () => new PieceFailure({})
        })
    });
  });

export const make = makeWithTestPreload();
export const layer = Layer.effect(Pieces, make);
