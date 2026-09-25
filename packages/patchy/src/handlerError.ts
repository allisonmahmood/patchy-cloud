// PROTOTYPE for #314: a handler's own structured failure, shared by `patchy/server` (where it
// is thrown) and `patchy/client` (where it is rethrown from a `server.call` reply). Distinct
// from `PatchyError`, which is Patchy declining or failing to run the handler.
import type { Json } from "./config.js";

export class HandlerError<Code extends string = string> extends Error {
  override readonly name = "HandlerError";
  readonly source = "handler" as const;
  constructor(
    readonly code: Code,
    readonly details?: Json
  ) {
    super(`Handler error: ${code}`);
  }
}

export function isHandlerError<Code extends string>(
  error: unknown,
  code: Code
): error is HandlerError<Code>;
export function isHandlerError(error: unknown): error is HandlerError;
export function isHandlerError(error: unknown, code?: string): error is HandlerError {
  // Structural, not instanceof: `patchy/server` and `patchy/client` are bundled separately, so a
  // guest that throws through one and narrows through the other sees two classes.
  return (
    error instanceof Error &&
    error.name === "HandlerError" &&
    (error as { source?: unknown }).source === "handler" &&
    typeof (error as { code?: unknown }).code === "string" &&
    (code === undefined || (error as { code?: unknown }).code === code)
  );
}
