// Turns handler refusals and Patchy errors into plain sentences for people.
import { isHandlerError, isPatchyError } from "../patchy/_generated/client.js";
import { STAGE_LABELS, isStage } from "../helpers/pipeline.js";
import { firstName } from "./format.js";

type Details = Readonly<Record<string, unknown>>;

const detailsOf = (error: { readonly details?: unknown }): Details =>
  typeof error.details === "object" && error.details !== null && !Array.isArray(error.details)
    ? (error.details as Details)
    : {};

const text = (value: unknown) => (typeof value === "string" ? value : null);
const stageName = (value: unknown) =>
  typeof value === "string" && isStage(value) ? STAGE_LABELS[value] : "this stage";

export function describeError(error: unknown): string {
  if (isHandlerError(error, "needs_value_and_owner")) {
    const details = detailsOf(error);
    const missing = Array.isArray(details.missing) ? details.missing : [];
    const needs = [
      missing.includes("value") ? "a value" : null,
      missing.includes("owner") ? "an owner" : null
    ]
      .filter(Boolean)
      .join(" and ");
    return `Add ${needs || "a value and an owner"} before moving to ${stageName(details.stage)}.`;
  }
  if (isHandlerError(error, "owner_or_admin_only")) {
    const details = detailsOf(error);
    const owner = text(details.owner);
    const who = owner === null ? "An admin" : `Only ${firstName(owner)} (the owner) or an admin`;
    switch (details.action) {
      case "reopen":
        return owner === null
          ? "Only an admin can reopen a deal with no owner."
          : `${who} can reopen this deal.`;
      case "reassign":
        return `${who} can hand this deal to someone else.`;
      default:
        return owner === null
          ? "Only an admin can close a deal with no owner. Assign an owner first."
          : `${who} can close this deal.`;
    }
  }
  if (isHandlerError(error, "reason_required"))
    return "Pick a reason before marking this deal lost.";
  if (isHandlerError(error, "value_required"))
    return `A deal in ${stageName(detailsOf(error).stage)} needs a value. Move it back to Discovery to clear it.`;
  if (isHandlerError(error, "owner_required"))
    return `A deal in ${stageName(detailsOf(error).stage)} needs an owner. Move it back to Discovery to unassign it.`;
  if (isHandlerError(error, "not_a_member"))
    return "That person isn't an active member of the studio any more, so they can't own deals.";
  if (isHandlerError(error, "invalid_input"))
    return text(detailsOf(error).message) ?? "Check the details and try again.";
  if (isHandlerError(error, "invalid_rows")) {
    const details = detailsOf(error);
    const first = Array.isArray(details.rows)
      ? (details.rows[0] as Details | undefined)
      : undefined;
    if (first !== undefined)
      return `Nothing was imported. Row ${String(first.row)}: ${String(first.message)}`;
    return text(details.message) ?? "Nothing was imported. Check the file and try again.";
  }
  if (isHandlerError(error, "not_empty"))
    return "The board already has deals, so the sample data wasn't added.";
  if (isHandlerError(error, "not_found")) return "This deal no longer exists.";

  if (isPatchyError(error, "unknown_outcome"))
    return "We couldn't confirm that change went through. Check the board before trying again.";
  if (isPatchyError(error, "write_conflict"))
    return "Someone changed this deal at the same moment. Try again.";
  if (
    isPatchyError(error, "busy") ||
    isPatchyError(error, "rate_limited") ||
    isPatchyError(error, "limit_exceeded")
  )
    return "Patchy is busy for a moment. Try again shortly.";
  if (isPatchyError(error, "handler_timeout")) return "That took too long to save. Try again.";
  return "Something went wrong. Try again.";
}

/** The viewer dismissed the shell's download card; not a failure worth reporting. */
export const isDismissedDownload = (error: unknown) =>
  isPatchyError(error, "invalid_request") && detailsOf(error).reason === "download_discarded";
