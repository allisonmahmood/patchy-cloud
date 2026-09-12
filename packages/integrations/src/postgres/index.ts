import type { PostgresDeclaration } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineIntegration } from "../definition.js";
import { Snapshot } from "./Snapshot.js";
import * as Source from "./Source.js";

export class PostgresOperationsUnavailable extends Schema.TaggedError<PostgresOperationsUnavailable>()(
  "PostgresOperationsUnavailable",
  {}
) {
  readonly code = "source_unavailable";
  override get message() {
    return "Postgres connections can be declared, but their operations, generated client and local fixtures are not available in this release.";
  }
}

// Refuse rather than producing empty files or claiming a local binding exists.
const generate: (
  declaration: typeof PostgresDeclaration.Type,
  metadata: typeof Snapshot.Type
) => Result.Result<never, PostgresOperationsUnavailable> = () =>
  Result.fail(new PostgresOperationsUnavailable({}));
const dev: (
  metadata: typeof Snapshot.Type,
  fixture: string
) => Layer.Layer<never, PostgresOperationsUnavailable> = () =>
  Layer.effectDiscard(Effect.fail(new PostgresOperationsUnavailable({})));

export const postgres = defineIntegration({
  name: "postgres",
  modes: ["company"],
  credentials: Source.Credentials,
  metadata: {
    schema: Snapshot,
    discover: Effect.fn("Postgres.metadata.discover")(function* (
      credentials: typeof Source.Credentials.Type
    ) {
      const source = yield* Source.Source;
      return (yield* source.inspect(credentials)).snapshot;
    })
  },
  operations: {},
  generate,
  dev
});
