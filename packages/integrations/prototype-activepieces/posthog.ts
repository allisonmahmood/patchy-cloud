import { createRequire } from "node:module";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Source from "../src/posthog/Source.js";
import { loadPiece } from "./adapter.js";

const require = createRequire(import.meta.url);
const Result = Schema.Struct({
  columns: Schema.Array(Schema.String),
  types: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  hasMore: Schema.Boolean
});
const decodeResult = Schema.decodeUnknownEffect(Result);

/**
 * Only provider-specific glue: credential field names and result mapping. The existing
 * community action constructs, authenticates and sends the API request, without modification.
 * The host supplies a loopback URL in the mock demo; patch code cannot choose the host.
 */
export const makeSource = (
  apiHost = (credentials: Source.Credentials) => Source.hosts[credentials.region]
) =>
  Effect.gen(function* () {
    const native = yield* Source.Source;
    const piece = yield* Effect.tryPromise({
      try: () =>
        loadPiece(
          { modulePath: require.resolve("@activepieces/piece-posthog"), exportName: "posthog" },
          ["run_hogql_query"]
        ),
      catch: (cause) => new Source.Unavailable({ stage: "request", cause: Redacted.make(cause) })
    });
    return Source.Source.of({
      ...native,
      query: Effect.fn("ActivepiecesPrototype.query")(function* (credentials, request) {
        // The existing action has no placeholder-values prop. Never silently drop values or
        // interpolate SQL to pretend it supports the native client's complete contract.
        if (request.values !== undefined)
          return yield* new Source.InvalidQuery({
            details: { message: "This prototype action does not support placeholder values." }
          });
        const raw = yield* Effect.tryPromise({
          try: () =>
            piece.run(
              "run_hogql_query",
              {
                props: {
                  personal_api_key: credentials.apiKey,
                  project_id: String(credentials.projectId),
                  api_host: apiHost(credentials)
                }
              },
              { query: request.query }
            ),
          // Provider/module errors may contain secrets. No raw error text crosses the boundary.
          catch: (cause) =>
            new Source.Unavailable({ stage: "request", cause: Redacted.make(cause) })
        });
        const result = yield* decodeResult(raw).pipe(
          Effect.mapError(
            (cause) => new Source.Unavailable({ stage: "response", cause: Redacted.make(cause) })
          )
        );
        if (result.columns.length !== result.types.length)
          return yield* new Source.Unavailable({ stage: "response" });
        return {
          columns: result.columns,
          types: result.columns.map((column, index) => [column, result.types[index]!] as const),
          results: result.rows.map((row) => result.columns.map((column) => row[column])),
          hasMore: result.hasMore
        };
      })
    });
  });
