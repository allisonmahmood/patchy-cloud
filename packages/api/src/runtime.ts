/** The browser runtime wire; operation schemas are shared by the shell and server. */
import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { registry } from "@patchy/limits/registry";
import { DefinitionName, Identity, IsoTimestamp, PatchId, PostgresText } from "./schemas.js";
import { postgresOperations } from "./postgres.js";
import { limitRefusalFields } from "./limits.js";
import { HandlerName } from "./handlers.js";

/** Release contract shared by the browser broker and server runtime. */
export const runtimeByteLimits = {
  callBytes: registry["runtime.call.bytes"].default,
  rowBytes: registry["runtime.row.bytes"].default,
  batchBytes: registry["runtime.batch.bytes"].default,
  postgresBytes: registry["runtime.postgres.bytes"].default,
  serverArgsBytes: registry["tier2.args.bytes"].default,
  resultBytes: registry["runtime.result.bytes"].default,
  fileBytes: registry["runtime.file.bytes"].default
} as const;

export type RuntimeBodyLimitId =
  | "runtime.call.bytes"
  | "runtime.row.bytes"
  | "runtime.batch.bytes"
  | "runtime.postgres.bytes"
  | "tier2.args.bytes";

export function runtimeBodyLimitId(op: string): RuntimeBodyLimitId {
  return op === "tables.insert" || op === "tables.update"
    ? "runtime.row.bytes"
    : op === "tables.insertMany"
      ? "runtime.batch.bytes"
      : op.startsWith("postgres.")
        ? "runtime.postgres.bytes"
        : op === "server.call"
          ? "tier2.args.bytes"
          : "runtime.call.bytes";
}

export function runtimeBodyLimit(
  op: string,
  limits: {
    readonly callBytes: number;
    readonly rowBytes: number;
    readonly batchBytes: number;
    readonly postgresBytes: number;
    readonly serverArgsBytes: number;
  } = runtimeByteLimits
): number {
  switch (runtimeBodyLimitId(op)) {
    case "runtime.row.bytes":
      return limits.rowBytes + limits.callBytes;
    case "runtime.batch.bytes":
      return limits.batchBytes + limits.callBytes;
    case "runtime.postgres.bytes":
      return limits.postgresBytes;
    case "tier2.args.bytes":
      return limits.serverArgsBytes + limits.callBytes;
    case "runtime.call.bytes":
      return limits.callBytes;
  }
}

const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
const textEncoder = new TextEncoder();

/** Shared by operation arguments and the decoded wildcard route parameter. */
export const FileName = PostgresText.check(
  Schema.makeFilter(
    (value) =>
      (textEncoder.encode(value).byteLength <= 512 &&
        value
          .split("/")
          .every((segment) => segment !== "" && segment !== "." && segment !== "..")) ||
      "File names must be 1–512 bytes with no empty, . or .. segments."
  )
);
export const FileContentType = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+\/[a-zA-Z0-9!#$%&'*+.^_`|~-]+(?:;[\x20-\x7e]+)?$/.test(value) ||
      "Content-Type must be a media type without control characters."
  )
);
export const FileMetadata = Schema.Struct({
  name: FileName,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: FileContentType,
  updatedAt: IsoTimestamp
});
export const FilePage = Schema.Struct({
  files: Schema.Array(FileMetadata),
  cursor: Schema.NullOr(Schema.String)
});
/** A capability result, transferred as raw bytes by HTTP and ArrayBuffer by the broker. */
export const FileBody = Schema.Struct({ bytes: Schema.Uint8Array, contentType: FileContentType });
export type FileBody = typeof FileBody.Type;
export const FileList = Schema.Struct({
  store: DefinitionName,
  prefix: Schema.optionalKey(
    PostgresText.check(
      Schema.makeFilter(
        (value) =>
          textEncoder.encode(value).byteLength <= 512 || "File prefixes are at most 512 bytes."
      )
    )
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  cursor: Schema.optionalKey(NonEmptyText)
});

/** Version ids use core's newInternalId("ver") grammar. */
export const RuntimeVersionId = Schema.String.check(
  Schema.makeFilter((value) => /^ver_[a-z0-9]{24}$/.test(value) || "Invalid version ID.")
);

/** Null bootstraps `me`; a company shell binds every later call to its returned user. */
export const RuntimePrincipal = Schema.NullOr(Schema.Struct({ userId: NonEmptyText })).annotate({
  identifier: "RuntimePrincipal"
});
export type RuntimePrincipal = typeof RuntimePrincipal.Type;

/** One shell-owned SSE connection, bound to the document nonce rather than its URL. */
export const RuntimeStreamRequest = Schema.Struct({
  patchId: PatchId,
  versionId: RuntimeVersionId,
  documentId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
});
export type RuntimeStreamRequest = typeof RuntimeStreamRequest.Type;

export const RuntimeStreamFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"),
    generation: Schema.NonEmptyString,
    serverTime: Schema.Number
  }),
  Schema.Struct({
    type: Schema.Literal("served"),
    versionId: RuntimeVersionId,
    tier: Schema.Int
  }),
  Schema.Struct({ type: Schema.Literal("revoked") }),
  Schema.Struct({ type: Schema.Literal("session_expired") }),
  Schema.Struct({ type: Schema.Literal("access_denied") }),
  Schema.Struct({ type: Schema.Literal("principal_changed") }),
  Schema.Struct({ type: Schema.Literal("starting") }),
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({
    type: Schema.Literal("start_failed"),
    code: Schema.Literal("busy"),
    retryAfter: Schema.Number
  }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    reason: Schema.Literals(["slow_consumer", "replaced"])
  })
]).annotate({ identifier: "RuntimeStreamFrame" });
export type RuntimeStreamFrame = typeof RuntimeStreamFrame.Type;

/** SSE data fields contain RuntimeStreamFrame JSON, followed by a blank line. */
export const RuntimeEventStream = Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "text/event-stream" })
);

/** Public versions return null, including when their viewer has a session. */
export const RuntimeMe = Schema.NullOr(
  Schema.Struct({
    user: Identity.fields.user,
    company: Identity.fields.company,
    admin: Schema.Boolean
  })
).annotate({ identifier: "RuntimeMe" });
export type RuntimeMe = typeof RuntimeMe.Type;

export const TableRow = Schema.Record(Schema.String, Schema.Json);
export const TableRange = Schema.Struct({
  column: DefinitionName,
  gt: Schema.optionalKey(Schema.Json),
  gte: Schema.optionalKey(Schema.Json),
  lt: Schema.optionalKey(Schema.Json),
  lte: Schema.optionalKey(Schema.Json)
});
const listFields = {
  index: Schema.optionalKey(DefinitionName),
  eq: Schema.optionalKey(TableRow),
  range: Schema.optionalKey(TableRange),
  order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  cursor: Schema.optionalKey(NonEmptyText)
};
export const TableList = Schema.Struct({ table: DefinitionName, ...listFields });
export const SharedList = Schema.Struct({ alias: DefinitionName, ...listFields });
export const TablePage = Schema.Struct({
  rows: Schema.Array(TableRow),
  cursor: Schema.NullOr(Schema.String)
});

export const ServerCall = Schema.Struct({
  handler: HandlerName,
  args: Schema.Record(Schema.String, Schema.Json),
  mutationKey: Schema.optionalKey(NonEmptyText)
});
export type ServerCall = typeof ServerCall.Type;

/** Byte operations carry their bytes outside the JSON arguments. */
export const runtimeOperations = {
  ...postgresOperations,
  "server.call": {
    request: Schema.Struct({ op: Schema.Literal("server.call"), args: ServerCall }),
    response: Schema.suspend(() => ServerCallReply),
    kind: "mutation"
  },
  me: {
    request: Schema.Struct({
      op: Schema.Literal("me"),
      args: Schema.Record(Schema.String, Schema.Never)
    }),
    response: RuntimeMe,
    kind: "read"
  },
  "tables.get": {
    request: Schema.Struct({
      op: Schema.Literal("tables.get"),
      args: Schema.Struct({ table: DefinitionName, id: NonEmptyText })
    }),
    response: Schema.NullOr(TableRow),
    kind: "read"
  },
  "tables.getMany": {
    request: Schema.Struct({
      op: Schema.Literal("tables.getMany"),
      args: Schema.Struct({ table: DefinitionName, ids: Schema.Array(NonEmptyText) })
    }),
    response: Schema.Array(Schema.NullOr(TableRow)),
    kind: "read"
  },
  "tables.list": {
    request: Schema.Struct({ op: Schema.Literal("tables.list"), args: TableList }),
    response: TablePage,
    kind: "read"
  },
  "shared.get": {
    request: Schema.Struct({
      op: Schema.Literal("shared.get"),
      args: Schema.Struct({ alias: DefinitionName, id: NonEmptyText })
    }),
    response: Schema.NullOr(TableRow),
    kind: "read"
  },
  "shared.getMany": {
    request: Schema.Struct({
      op: Schema.Literal("shared.getMany"),
      args: Schema.Struct({ alias: DefinitionName, ids: Schema.Array(NonEmptyText) })
    }),
    response: Schema.Array(Schema.NullOr(TableRow)),
    kind: "read"
  },
  "shared.list": {
    request: Schema.Struct({ op: Schema.Literal("shared.list"), args: SharedList }),
    response: TablePage,
    kind: "read"
  },
  "tables.insert": {
    request: Schema.Struct({
      op: Schema.Literal("tables.insert"),
      args: Schema.Struct({ table: DefinitionName, row: TableRow })
    }),
    response: TableRow,
    kind: "mutation"
  },
  "tables.insertMany": {
    request: Schema.Struct({
      op: Schema.Literal("tables.insertMany"),
      args: Schema.Struct({ table: DefinitionName, rows: Schema.Array(TableRow) })
    }),
    response: Schema.Array(TableRow),
    kind: "mutation"
  },
  "tables.update": {
    request: Schema.Struct({
      op: Schema.Literal("tables.update"),
      args: Schema.Struct({ table: DefinitionName, id: NonEmptyText, patch: TableRow })
    }),
    response: TableRow,
    kind: "mutation"
  },
  "tables.delete": {
    request: Schema.Struct({
      op: Schema.Literal("tables.delete"),
      args: Schema.Struct({ table: DefinitionName, id: NonEmptyText })
    }),
    response: Schema.Null,
    kind: "mutation"
  },
  "files.put": {
    request: Schema.Struct({
      op: Schema.Literal("files.put"),
      args: Schema.Struct({ store: DefinitionName, name: FileName, contentType: FileContentType })
    }),
    response: Schema.Null,
    kind: "mutation"
  },
  "files.get": {
    request: Schema.Struct({
      op: Schema.Literal("files.get"),
      args: Schema.Struct({ store: DefinitionName, name: FileName })
    }),
    response: FileBody,
    kind: "read"
  },
  "files.list": {
    request: Schema.Struct({ op: Schema.Literal("files.list"), args: FileList }),
    response: FilePage,
    kind: "read"
  },
  "files.delete": {
    request: Schema.Struct({
      op: Schema.Literal("files.delete"),
      args: Schema.Struct({ store: DefinitionName, name: FileName })
    }),
    response: Schema.Null,
    kind: "mutation"
  }
} as const;

/** The operation-only discriminated union validated by the shell. */
export const RuntimeRequest = Schema.Union(
  Object.values(runtimeOperations).map((operation) => operation.request)
).annotate({
  identifier: "RuntimeRequest"
});
export type RuntimeRequest = typeof RuntimeRequest.Type;

const envelopeFields = {
  patchId: PatchId,
  versionId: RuntimeVersionId,
  principal: RuntimePrincipal,
  wire: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
};

/** Admission reads this before operation validation, so public refusals include unknown ops. */
export const RuntimeEnvelope = Schema.Struct({
  ...envelopeFields,
  principal: Schema.Unknown,
  op: Schema.String,
  args: Schema.Unknown
}).annotate({ identifier: "RuntimeEnvelope" });
export type RuntimeEnvelope = typeof RuntimeEnvelope.Type;

/** The transport envelope paired with each admitted operation's exact request. */
export const RuntimeCall = Schema.Union(
  Object.values(runtimeOperations).map((operation) =>
    Schema.Struct({ ...envelopeFields, ...operation.request.fields })
  )
).annotate({ identifier: "RuntimeCall" });
export type RuntimeCall = typeof RuntimeCall.Type;

/** Failures shared by every integration operation, independent of its source. */
export const IntegrationBoundaryCode = Schema.Literals([
  "connection_not_declared",
  "access_denied",
  "invalid_request",
  "timeout",
  "too_large",
  "source_unavailable"
]);
export type IntegrationBoundaryCode = typeof IntegrationBoundaryCode.Type;

/** Every code in the stable runtime wire, including shell-local and future-operation failures. */
export const RuntimeCode = Schema.Literals([
  ...IntegrationBoundaryCode.literals,
  "table_not_declared",
  "row_not_found",
  "invalid_row",
  "unique_violation",
  "invalid_cursor",
  "not_additive",
  "relation_unknown",
  "invalid_query",
  "shape_mismatch",
  "session_expired",
  "session_refresh_required",
  "principal_changed",
  "not_available_on_public",
  "shell_outdated",
  "unknown_outcome",
  "rate_limited",
  "too_many_requests",
  "busy",
  "handler_failed",
  "handler_timeout",
  "write_conflict",
  "patch_paused",
  "server_required",
  "tier2_not_public",
  "limit_exceeded",
  "offset_exhausted"
]).annotate({ identifier: "RuntimeCode" });
export type RuntimeCode = typeof RuntimeCode.Type;

/** Logged failures carry their row's correlation id; read and shell-local failures do not. */
export const RuntimeFailure = Schema.Struct({
  ok: Schema.Literal(false),
  source: Schema.Literal("patchy"),
  error: Schema.String,
  code: RuntimeCode,
  ...limitRefusalFields,
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  correlationId: Schema.optionalKey(NonEmptyText)
}).annotate({ identifier: "RuntimeFailure" });
export type RuntimeFailure = typeof RuntimeFailure.Type;

/** Declared handler errors are reply data, distinct from Patchy's refusals. */
export const HandlerFailure = Schema.Struct({
  ok: Schema.Literal(false),
  source: Schema.Literal("handler"),
  code: NonEmptyText,
  details: Schema.optionalKey(Schema.Json)
}).annotate({ identifier: "HandlerFailure" });
export type HandlerFailure = typeof HandlerFailure.Type;

/**
 * Primitive responses encode their value before this envelope. server.call already returns
 * ServerCallReply, preserving a declared HandlerFailure as an HTTP 200 reply.
 * `value` stays plain JSON: a union of every response would match a table row with `ok`
 * and `rows` columns to a Postgres result and drop the row's other keys.
 */
export const RuntimeSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Json
}).annotate({ identifier: "RuntimeSuccess" });
export type RuntimeSuccess = typeof RuntimeSuccess.Type;

/** server.call resolves either validated handler data or a declared business error. */
export const ServerCallReply = Schema.Union([RuntimeSuccess, HandlerFailure]).annotate({
  identifier: "ServerCallReply"
});
export type ServerCallReply = typeof ServerCallReply.Type;

export const RuntimeReply = Schema.Union([RuntimeSuccess, RuntimeFailure, HandlerFailure]).annotate(
  {
    identifier: "RuntimeReply"
  }
);
export type RuntimeReply = typeof RuntimeReply.Type;

/** Decode after admission; route params themselves stay permissive for runtime-shaped refusals. */
export const RuntimeFileParams = Schema.Struct({
  patchId: PatchId,
  versionId: RuntimeVersionId,
  store: DefinitionName,
  name: FileName
});
export type RuntimeFileParams = typeof RuntimeFileParams.Type;

/** Bytes, never JSON/base64 or a public object URL; handlers supply the actual Content-Type. */
export const RuntimeBytes = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array());
