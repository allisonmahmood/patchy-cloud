import type { Json } from "./config.js";

export class HandlerError<Code extends string = string> extends Error {
  readonly source = "handler";
  constructor(
    readonly code: Code,
    readonly details?: Json
  ) {
    super(code);
    this.name = "HandlerError";
  }
}

/** Structural identity works across the server and browser bundles. */
export const isHandlerError = <Code extends string>(
  error: unknown,
  code: Code
): error is HandlerError<Code> =>
  error instanceof Error &&
  "source" in error &&
  error.source === "handler" &&
  "code" in error &&
  error.code === code;

/** The broker sends business refusals on its error channel, never inside a successful value. */
export function decodeHandlerError(value: unknown): HandlerError | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== false ||
    !("source" in value) ||
    value.source !== "handler" ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    value.code.length === 0
  )
    return undefined;
  return new HandlerError(value.code, "details" in value ? (value.details as Json) : undefined);
}
