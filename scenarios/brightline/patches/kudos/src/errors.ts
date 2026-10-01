import { isPatchyError } from "../patchy/_generated/client.js";

/** Plain-language text for a failed write. `what` completes "Your ___ didn't save." */
export function writeFailure(cause: unknown, what: string): string {
  if (isPatchyError(cause, "unknown_outcome")) {
    return `We couldn't confirm your ${what} went through. Check the wall before trying again.`;
  }
  if (
    isPatchyError(cause, "rate_limited") ||
    isPatchyError(cause, "too_many_requests") ||
    isPatchyError(cause, "limit_exceeded") ||
    isPatchyError(cause, "busy")
  ) {
    return "Lots happening right now. Wait a moment and try again.";
  }
  return `Your ${what} didn't save. Try again in a moment.`;
}
