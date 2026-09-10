/** Lightweight runtime-code contract; the browser acceptance test checks it against packages/api. */
export const errorCodes = {
  connection_not_declared: true,
  access_denied: true,
  invalid_request: true,
  timeout: true,
  too_large: true,
  source_unavailable: true,
  table_not_declared: true,
  row_not_found: true,
  invalid_row: true,
  unique_violation: true,
  invalid_cursor: true,
  not_additive: true,
  relation_unknown: true,
  invalid_query: true,
  shape_mismatch: true,
  session_expired: true,
  principal_changed: true,
  not_available_on_public: true,
  shell_outdated: true,
  unknown_outcome: true,
  rate_limited: true,
  too_many_requests: true,
  busy: true,
  offset_exhausted: true
} as const;
export type ErrorCode = keyof typeof errorCodes;
export type RelationIdentifier = { readonly schema: string; readonly name: string };
export type ShapeMismatchDetails =
  | {
      readonly column: string;
      readonly reason: "missing" | "duplicate" | "type" | "null" | "value" | "row_width";
    }
  | { readonly relation: RelationIdentifier; readonly reason: "source_schema_changed" };
export type ErrorDetails<C extends ErrorCode> = C extends "invalid_query"
  ? { readonly sqlstate: string; readonly message: string; readonly position?: string }
  : C extends "shape_mismatch"
    ? ShapeMismatchDetails
    : C extends "relation_unknown"
      ? { readonly relation: RelationIdentifier }
      : C extends "offset_exhausted"
        ? { readonly maxOffset: 10000 }
        : C extends "too_large"
          ? { readonly maxRows?: 1000; readonly maxItems?: number; readonly maxBytes?: number }
          : Readonly<Record<string, unknown>>;

export class PatchyError<C extends ErrorCode = ErrorCode> extends Error {
  override readonly name = "PatchyError";
  constructor(
    readonly code: C,
    message: string,
    readonly details: ErrorDetails<C>,
    readonly correlationId?: string
  ) {
    super(message);
  }
}
export type Errors<C extends ErrorCode> = { [K in C]: PatchyError<K> }[C];
export function isPatchyError<C extends ErrorCode>(error: unknown, code: C): error is Errors<C>;
export function isPatchyError(error: unknown): error is Errors<ErrorCode>;
export function isPatchyError(error: unknown, code?: ErrorCode): error is Errors<ErrorCode> {
  return error instanceof PatchyError && (code === undefined || error.code === code);
}

/** Decode both the runtime failure document and the broker's nested error document. */
export function decodeError(value: unknown): PatchyError | undefined {
  if (isPatchyError(value)) return value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !Object.hasOwn(errorCodes, record.code)) return undefined;
  const message = typeof record.message === "string" ? record.message : record.error;
  if (typeof message !== "string") return undefined;
  const details =
    record.details !== null && typeof record.details === "object" && !Array.isArray(record.details)
      ? (record.details as ErrorDetails<ErrorCode>)
      : {};
  return new PatchyError(
    record.code as ErrorCode,
    message,
    details,
    typeof record.correlationId === "string" ? record.correlationId : undefined
  );
}

// Known refusals, not checked or exhaustive TypeScript throws.
export type BoundaryError = Errors<
  | "access_denied"
  | "invalid_request"
  | "timeout"
  | "too_large"
  | "source_unavailable"
  | "session_expired"
  | "principal_changed"
  | "not_available_on_public"
  | "shell_outdated"
  | "unknown_outcome"
  | "rate_limited"
  | "too_many_requests"
  | "busy"
>;
export type TableGetError = BoundaryError | Errors<"table_not_declared">;
export type TableGetManyError = TableGetError;
export type TableListError = TableGetError | Errors<"invalid_cursor">;
export type TableInsertError = TableGetError | Errors<"invalid_row" | "unique_violation">;
export type TableInsertManyError = TableInsertError;
export type TableUpdateError = TableInsertError | Errors<"row_not_found">;
export type TableDeleteError = TableGetError;
export type SharedGetError = TableGetError;
export type SharedGetManyError = SharedGetError;
export type SharedListError = TableListError;
export type FileGetError = BoundaryError | Errors<"row_not_found" | "table_not_declared">;
export type FilePutError = BoundaryError | Errors<"table_not_declared">;
export type FileListError = FilePutError | Errors<"invalid_cursor">;
export type FileDeleteError = FilePutError;
export type FileUrlError = FileGetError;
export type MeError = BoundaryError;
