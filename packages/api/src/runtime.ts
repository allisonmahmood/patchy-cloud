/** The browser runtime wire; operation schemas are shared by the shell and server. */
import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { DefinitionName, Identity, IsoTimestamp, PatchId, PostgresText } from "./schemas.js";

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
  identifier: "RuntimePrincipal",
  parseOptions: { onExcessProperty: "error" }
});
export type RuntimePrincipal = typeof RuntimePrincipal.Type;

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
export const TableList = Schema.Struct({
  table: DefinitionName,
  index: Schema.optionalKey(DefinitionName),
  eq: Schema.optionalKey(TableRow),
  range: Schema.optionalKey(TableRange),
  order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  cursor: Schema.optionalKey(NonEmptyText)
});
export const TablePage = Schema.Struct({
  rows: Schema.Array(TableRow),
  cursor: Schema.NullOr(Schema.String)
});

/** Byte operations carry their bytes outside the JSON arguments. */
export const runtimeOperations = {
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
  identifier: "RuntimeRequest",
  parseOptions: { onExcessProperty: "error" }
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
).annotate({ identifier: "RuntimeCall", parseOptions: { onExcessProperty: "error" } });
export type RuntimeCall = typeof RuntimeCall.Type;

/** Every code in the stable runtime wire, including shell-local and future-operation failures. */
export const RuntimeCode = Schema.Literals([
  "table_not_declared",
  "row_not_found",
  "invalid_row",
  "unique_violation",
  "access_denied",
  "invalid_cursor",
  "not_additive",
  "connection_not_declared",
  "invalid_request",
  "timeout",
  "too_large",
  "source_unavailable",
  "relation_unknown",
  "invalid_query",
  "shape_mismatch",
  "session_expired",
  "principal_changed",
  "not_available_on_public",
  "shell_outdated",
  "unknown_outcome",
  "rate_limited",
  "too_many_requests",
  "busy",
  "offset_exhausted"
]).annotate({ identifier: "RuntimeCode" });
export type RuntimeCode = typeof RuntimeCode.Type;

/** Logged failures carry their row's correlation id; read and shell-local failures do not. */
export const RuntimeFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
  code: RuntimeCode,
  correlationId: Schema.optionalKey(NonEmptyText)
}).annotate({ identifier: "RuntimeFailure" });
export type RuntimeFailure = typeof RuntimeFailure.Type;

/** Each success value comes from that operation's response schema. */
export const RuntimeSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Union(Object.values(runtimeOperations).map((operation) => operation.response))
}).annotate({ identifier: "RuntimeSuccess" });
export type RuntimeSuccess = typeof RuntimeSuccess.Type;

export const RuntimeReply = Schema.Union([RuntimeSuccess, RuntimeFailure]).annotate({
  identifier: "RuntimeReply"
});
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
