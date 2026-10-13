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
  not_found: true,
  invalid_row: true,
  unique_violation: true,
  invalid_cursor: true,
  not_additive: true,
  relation_unknown: true,
  invalid_query: true,
  shape_mismatch: true,
  session_expired: true,
  session_refresh_required: true,
  principal_changed: true,
  not_available_on_public: true,
  shell_outdated: true,
  unknown_outcome: true,
  rate_limited: true,
  too_many_requests: true,
  busy: true,
  handler_failed: true,
  handler_timeout: true,
  write_conflict: true,
  patch_paused: true,
  server_required: true,
  tier2_not_public: true,
  limit_exceeded: true,
  offset_exhausted: true,
  source_rate_limited: true
} as const;
export type ErrorCode = keyof typeof errorCodes;
export type RelationIdentifier = { readonly schema: string; readonly name: string };
type ColumnReason = "missing" | "duplicate" | "type" | "null" | "value" | "row_width";
/**
 * Details follow the integration an operation belongs to. Postgres's are the default, so code
 * that narrows on the code alone keeps its types; PostHog's need its operation or integration.
 */
type PostHogOperation = `posthog.${string}`;
export type ShapeMismatchDetails<O extends string = string> = O extends PostHogOperation
  ? {
      readonly column: string;
      readonly reason: ColumnReason;
      /** PostHog's ClickHouse type for the column, when it was the problem. */
      readonly type?: string;
    }
  : | { readonly column: string; readonly reason: ColumnReason }
    | { readonly relation: RelationIdentifier; readonly reason: "source_schema_changed" };
export type ErrorDetails<C extends ErrorCode, O extends string = string> = C extends "invalid_query"
  ? O extends PostHogOperation
    ? { readonly message: string }
    : { readonly sqlstate: string; readonly message: string; readonly position?: string }
  : C extends "shape_mismatch"
    ? ShapeMismatchDetails<O>
    : C extends "relation_unknown"
      ? { readonly relation: RelationIdentifier }
      : C extends "offset_exhausted"
        ? { readonly maxOffset: 10000 }
        : C extends "too_large"
          ? { readonly maxRows?: 1000; readonly maxItems?: number; readonly maxBytes?: number }
          : Readonly<Record<string, unknown>>;

export class PatchyError<C extends ErrorCode = ErrorCode, O extends string = string> extends Error {
  override readonly name = "PatchyError";
  readonly source = "patchy";
  readonly scope?: "viewer" | "patch" | "company" | "host";
  readonly limitId?: string;
  readonly value?: number;
  readonly retryAfter?: number;
  /** The runtime operation a call made, such as `posthog.query`, when the call refused. */
  readonly operation?: O;
  /** Present only on an uncertain mutation; retry preserves its key and arguments. */
  declare readonly retry?: C extends "unknown_outcome" ? () => Promise<unknown> : never;
  constructor(
    readonly code: C,
    message: string,
    readonly details: ErrorDetails<C, O>,
    readonly correlationId?: string,
    limit?: Pick<PatchyError<C, O>, "scope" | "limitId" | "value" | "retryAfter" | "operation">
  ) {
    super(message);
    Object.assign(this, limit);
  }
}
export type Errors<C extends ErrorCode, O extends string = string> = {
  [K in C]: PatchyError<K, O>;
}[C];
/** The integrations whose refusals carry their own details. */
type Integration = "postgres" | "posthog";
/**
 * An integration or one of its operations. Each names exactly one integration, so the details
 * it narrows to are never a guess.
 */
type From = Integration | `${Integration}.${string}`;
/** An operation, or every operation of the integration it names: `posthog` is `posthog.*`. */
type Operations<F extends From> = F extends `${string}.${string}` ? F : `${F}.${string}`;
/**
 * Narrows to a Patchy refusal, optionally with this code and from an operation such as
 * `posthog.query` or an integration such as `posthog`, whose details it then carries.
 */
export function isPatchyError<C extends ErrorCode, const F extends From>(
  error: unknown,
  code: C,
  from: F
): error is Errors<C, Operations<F>>;
export function isPatchyError<C extends ErrorCode>(error: unknown, code: C): error is Errors<C>;
export function isPatchyError(error: unknown): error is Errors<ErrorCode>;
export function isPatchyError(
  error: unknown,
  code?: ErrorCode,
  from?: string
): error is Errors<ErrorCode> {
  return (
    error instanceof PatchyError &&
    (code === undefined || error.code === code) &&
    (from === undefined ||
      error.operation === from ||
      (error.operation?.startsWith(`${from}.`) ?? false))
  );
}

/**
 * Decode both the runtime failure document and the broker's nested error document, recording
 * the operation that refused: the document's own, which a handler relays, else the call's. An
 * error already decoded keeps the operation it has.
 */
export function decodeError(value: unknown, operation?: string): PatchyError | undefined {
  if (isPatchyError(value)) {
    if (operation !== undefined && value.operation === undefined)
      Object.defineProperty(value, "operation", { value: operation, enumerable: true });
    return value;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.source !== "patchy" || ("ok" in record && record.ok !== false)) return undefined;
  if (typeof record.code !== "string" || !Object.hasOwn(errorCodes, record.code)) return undefined;
  const message = typeof record.message === "string" ? record.message : record.error;
  if (typeof message !== "string") return undefined;
  const details =
    record.details !== null && typeof record.details === "object" && !Array.isArray(record.details)
      ? (record.details as ErrorDetails<ErrorCode>)
      : {};
  const origin =
    typeof record.operation === "string" && record.operation !== "" ? record.operation : operation;
  return new PatchyError(
    record.code as ErrorCode,
    message,
    details,
    typeof record.correlationId === "string" ? record.correlationId : undefined,
    {
      ...(record.scope === "viewer" ||
      record.scope === "patch" ||
      record.scope === "company" ||
      record.scope === "host"
        ? { scope: record.scope }
        : {}),
      ...(typeof record.limitId === "string" ? { limitId: record.limitId } : {}),
      ...(typeof record.value === "number" && Number.isFinite(record.value)
        ? { value: record.value }
        : {}),
      ...(typeof record.retryAfter === "number" &&
      Number.isFinite(record.retryAfter) &&
      record.retryAfter >= 0
        ? { retryAfter: record.retryAfter }
        : {}),
      ...(origin === undefined ? {} : { operation: origin })
    }
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
