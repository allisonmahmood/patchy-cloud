// @effect-diagnostics nodeBuiltinImport:off -- DNS resolution and socket creation are the native transport boundary.
import { lookup } from "node:dns/promises";
import { Socket } from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class LookupFailed extends Schema.TaggedError<LookupFailed>()("LookupFailed", {
  host: Schema.String,
  cause: Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true })
}) {
  override get message() {
    return `DNS lookup failed for ${this.host}.`;
  }
}

/** Tests replace only DNS and socket creation; SourceClient retains admission and TLS. */
export class SourceNetwork extends Context.Service<
  SourceNetwork,
  {
    readonly resolve: (
      host: string
    ) => Effect.Effect<ReadonlyArray<{ readonly address: string }>, LookupFailed>;
    readonly socket: Effect.Effect<Socket>;
  }
>()("@patchy/integrations/postgres/SourceNetwork") {}

export const layer = Layer.succeed(SourceNetwork, {
  resolve: Effect.fn("Postgres.lookup")((host: string) =>
    Effect.tryPromise({
      try: () => lookup(host, { all: true, verbatim: true }),
      catch: (cause) => new LookupFailed({ host, cause: Redacted.make(cause) })
    })
  ),
  socket: Effect.sync(() => new Socket())
});
