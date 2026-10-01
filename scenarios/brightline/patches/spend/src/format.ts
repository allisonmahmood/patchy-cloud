import { isPatchyError } from "../patchy/_generated/client.js";
import { formatMoney, statuses, type Status } from "../helpers/spend.js";
import type { Board } from "./data.js";

type Person = Board["people"][number];

export const statusLabel: Record<Status, string> = {
  submitted: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  paid: "Paid"
};

/** Rows store status as text; anything unexpected reads as still waiting. */
export const asStatus = (value: string): Status =>
  statuses.find((status) => status === value) ?? "submitted";

const hour = 60 * 60 * 1000;
const day = 24 * hour;

/** Compact age for lists: "now", "45m", "5h", "3d", or a date after a month. */
export function age(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (elapsed < 60_000) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)}d`;
  return shortDate(iso);
}

/** "Sep 18" this year, "Sep 18, 2025" otherwise. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" })
  });
}

/** "Sep 18 at 2:40 PM" for the audit trail. */
export function dateTime(iso: string): string {
  const date = new Date(iso);
  return `${shortDate(iso)} at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** "just now", "5 hours ago", "3 days ago", then "on Sep 18"; matches the list's age column. */
export function relativeDay(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (elapsed < hour) return "just now";
  if (elapsed < day) return plural(Math.floor(elapsed / hour), "hour");
  if (elapsed < 30 * day) return plural(Math.floor(elapsed / day), "day");
  return `on ${shortDate(iso)}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse what someone typed in the amount box ("1,250.5", "$80") into integer cents; NaN when unreadable. */
export function parseAmount(text: string): number {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === "" || cleaned === ".") return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

/** "1,250.00" for the amount box after editing. */
export const amountInput = (cents: number) => formatMoney(cents).replace("$", "");

export const firstName = (person: Person | undefined) => person?.name.split(" ")[0] ?? "Someone";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`
      : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A stable avatar colour index (0-4) per member id. */
export function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 5;
}

/** The words to show for a failed call: a handler's own refusal, or a plain fallback. */
export function messageOf(error: unknown): string {
  if (
    error instanceof Error &&
    "source" in error &&
    error.source === "handler" &&
    "details" in error
  ) {
    const details = error.details;
    if (
      typeof details === "object" &&
      details !== null &&
      "message" in details &&
      typeof details.message === "string"
    )
      return details.message;
  }
  if (isPatchyError(error)) {
    switch (error.code) {
      case "busy":
      case "rate_limited":
      case "too_many_requests":
      case "limit_exceeded":
        return "Patchy is busy right now. Try again in a moment.";
      case "unknown_outcome":
        return "We lost the connection before hearing back. Check the list before trying again.";
      case "too_large":
        return "That file is too large to upload.";
      case "not_found":
        return "That file is no longer available. Attach it again.";
      default:
        break;
    }
  }
  return "Something went wrong. Try again.";
}
