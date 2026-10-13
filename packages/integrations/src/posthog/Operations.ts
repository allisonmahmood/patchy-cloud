import { PostgresRows, PostHogQuery } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation } from "../definition.js";
import * as Mapping from "./Mapping.js";
import * as Source from "./Source.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "PostHogConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This PostHog connection is not declared by this version.";
  }
}

/** The key or project stopped working after connect; only an admin can fix it. */
export class ConnectionRefused extends Schema.TaggedError<ConnectionRefused>()(
  "PostHogConnectionRefused",
  { cause: Schema.Union([Source.KeyRejected, Source.AccessDenied, Source.ProjectNotFound]) }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "PostHog refused this connection's key or project. Ask a company administrator to check it at /company/connections.";
  }
}

export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()("PostHogShapeMismatch", {
  column: Schema.String,
  reason: Schema.Literals(["missing", "duplicate", "type", "null", "value", "row_width"]),
  /** PostHog's ClickHouse type for the column, when it was the problem. */
  type: Schema.optionalKey(Schema.String)
}) {
  readonly code = "shape_mismatch" as const;
  readonly status = 400;
  override get message() {
    return `The PostHog result does not match the declared shape (${this.reason}${this.column === "" ? "" : ` at ${this.column}`}).`;
  }
  get details() {
    return {
      column: this.column,
      reason: this.reason,
      ...(this.type === undefined ? {} : { type: this.type })
    };
  }
}

/** PostHog stopped short of the whole result; Patchy never passes on a part as if it were all. */
export class Truncated extends Schema.TaggedError<Truncated>()("PostHogTruncated", {}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return `PostHog returned only part of this result. Add a LIMIT of at most ${MAX_ROWS} rows, or aggregate.`;
  }
  get details() {
    return { maxRows: MAX_ROWS, reason: "truncated" };
  }
}

export class TooManyRows extends Schema.TaggedError<TooManyRows>()("PostHogTooManyRows", {}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return `A PostHog query returns at most ${MAX_ROWS} rows. Add a LIMIT, or aggregate.`;
  }
  get details() {
    return { maxRows: MAX_ROWS };
  }
}

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  ConnectionRefused,
  ShapeMismatch,
  Truncated,
  TooManyRows,
  Source.RateLimited,
  Source.Unavailable,
  Source.Timeout,
  Source.InvalidQuery,
  Source.TooLarge,
  Source.Busy,
  Runtime.InvalidRequest,
  Runtime.AccessDenied,
  Runtime.SourceUnavailable,
  Runtime.TooLarge
]);

const MAX_ROWS = 1_000;
const MAX_BYTES = registry["runtime.result.bytes"].default;
const DEADLINE_MS = registry["integration.deadline"].default;
type Row = Record<string, typeof Schema.Json.Type>;
const isJson = Schema.is(Schema.Json);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();

/** The declared connection, its live state and its credentials, for this viewer only. */
const resolve = Effect.fn("PostHogOperations.resolve")(function* (alias: string) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[alias];
  if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "posthog")
    return yield* new ConnectionNotDeclared({});
  if (
    binding.scope !== "company" ||
    binding.identity === null ||
    binding.principal === null ||
    binding.identity.company.id !== binding.companyId ||
    binding.identity.user.id !== binding.principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  const connections = yield* ConnectionStore.ConnectionStore;
  const connection = yield* connections
    .get(binding.companyId, declaration.id)
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotFound"
          ? new Runtime.AccessDenied({ cause })
          : new Runtime.SourceUnavailable({ cause })
      )
    );
  if (
    connection.companyId !== binding.companyId ||
    connection.id !== declaration.id ||
    connection.integration !== "posthog" ||
    connection.mode !== "company" ||
    connection.handle !== declaration.handle ||
    connection.status !== "connected"
  )
    return yield* new Runtime.AccessDenied({});
  const secret = yield* connections
    .poolCredentials(binding.companyId, declaration, connection.credentialRevision)
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotConnected" || cause._tag === "ConnectionNotFound"
          ? new Runtime.AccessDenied({ cause })
          : new Runtime.SourceUnavailable({ cause })
      )
    );
  const credentials = yield* Source.parseCredentials(secret).pipe(
    Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
  );
  return { binding, credentials };
});

/** PostHog's columns, types and rows through the declared shape; anything else is refused. */
export const shaped = Effect.fn("PostHogOperations.shaped")(function* (
  response: Source.QueryResponse,
  shape: (typeof PostHogQuery.Type)["shape"]
) {
  if (response.hasMore) return yield* new Truncated({});
  if (response.results.length > MAX_ROWS) return yield* new TooManyRows({});
  if (response.types.length !== response.columns.length)
    return yield* new Source.Unavailable({ stage: "response" });
  const indices = new Map<string, number>();
  for (const [index, column] of response.columns.entries()) {
    if (indices.has(column)) return yield* new ShapeMismatch({ column, reason: "duplicate" });
    indices.set(column, index);
  }
  const columns: Array<{
    readonly name: string;
    readonly index: number;
    readonly kind: (typeof shape)[string]["kind"];
    readonly optional: boolean;
    readonly type: string;
  }> = [];
  for (const [name, column] of Object.entries(shape)) {
    const index = indices.get(name);
    if (index === undefined) return yield* new ShapeMismatch({ column: name, reason: "missing" });
    const type = response.types[index]![1];
    if (!Mapping.compatible(column.kind, type))
      return yield* new ShapeMismatch({ column: name, reason: "type", type });
    columns.push({
      name,
      index,
      kind: column.kind,
      optional: column.optional === true,
      type
    });
  }
  const rows: Row[] = [];
  for (const source of response.results) {
    if (source.length !== response.columns.length)
      return yield* new ShapeMismatch({ column: "", reason: "row_width" });
    const row: Row = {};
    for (const column of columns) {
      const raw = source[column.index];
      let value: unknown = null;
      if (raw === null || raw === undefined) {
        if (!column.optional)
          return yield* new ShapeMismatch({ column: column.name, reason: "null" });
      } else {
        value = Mapping.value(column.kind, column.type, raw);
        if (value === undefined || !isJson(value))
          return yield* new ShapeMismatch({
            column: column.name,
            reason: "value",
            type: column.type
          });
      }
      Object.defineProperty(row, column.name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    rows.push(row);
  }
  const result = { ok: true as const, rows };
  if (encoder.encode(encodeJson(result)).byteLength > MAX_BYTES)
    return yield* new Runtime.TooLarge({ maxBytes: MAX_BYTES, limitId: "runtime.result.bytes" });
  return result;
});

const query = operation({
  input: PostHogQuery,
  output: PostgresRows,
  errors: Errors,
  run: Effect.fn("PostHogOperations.query")(function* (args: typeof PostHogQuery.Type) {
    const { binding, credentials } = yield* resolve(args.connection);
    const source = yield* Source.Source;
    // The caller's own deadline bounds the wait for a slot, so a refused wait is never a timeout.
    const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
    const response = yield* source
      .withSlot(
        credentials,
        deadline
      )(
        Effect.gen(function* () {
          // The connection may have been disconnected, rotated or pointed elsewhere while this
          // call waited: send only with what it holds now, and never to a project it left.
          const current = yield* resolve(args.connection);
          if (
            current.credentials.region !== credentials.region ||
            current.credentials.projectId !== credentials.projectId
          )
            return yield* new Runtime.SourceUnavailable({
              cause: new ConnectionStore.ConnectionChanged({})
            });
          return yield* source.query(current.credentials, {
            name: args.name,
            query: args.query,
            ...(args.values === undefined ? {} : { values: args.values })
          });
        })
      )
      .pipe(
        Effect.catchTags({
          PostHogKeyRejected: (cause) => Effect.fail(new ConnectionRefused({ cause })),
          PostHogAccessDenied: (cause) => Effect.fail(new ConnectionRefused({ cause })),
          PostHogProjectNotFound: (cause) => Effect.fail(new ConnectionRefused({ cause }))
        })
      );
    return yield* shaped(response, args.shape);
  })
});

export const operations = { query };

const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "posthog" ? declaration.id : null;
};

/** Production and dev share one Source, so a project's gate spans both. */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  return {
    "posthog.query": Runtime.handler(
      {
        kind: "integration",
        ...query,
        // The query's name labels the call in recent calls, where a relation would.
        resource: (args) =>
          Predicate.isObject(args) && typeof args.name === "string"
            ? args.name.slice(0, 100)
            : null,
        connectionId,
        rowCount: (value) =>
          Predicate.isObject(value) && Array.isArray(value.rows) ? value.rows.length : null,
        sql: (args) =>
          Predicate.isObject(args) && typeof args.query === "string" ? args.query : undefined
      },
      (args) =>
        query
          .run(args)
          .pipe(
            Effect.provideService(Source.Source, source),
            Effect.provideService(ConnectionStore.ConnectionStore, connections)
          )
    )
  };
});
