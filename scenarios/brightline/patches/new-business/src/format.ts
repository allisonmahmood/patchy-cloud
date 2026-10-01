// Display formatting for money, dates and people.

export const DAY = 86_400_000;

/** "$48k", "$1.25M"; for cards, column totals and KPIs. */
export function compactMoney(value: number) {
  if (value >= 999_500) return `$${trimZeros((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1000) return `$${Math.round(value / 1000)}k`;
  return `$${value}`;
}

const trimZeros = (text: string) => text.replace(/\.?0+$/, "");

/** "$48,000"; for the drawer and exports. */
export const fullMoney = (value: number) => `$${value.toLocaleString("en-US")}`;

export const daysSince = (iso: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(iso)) / DAY));

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const longDate = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });

/** A stored YYYY-MM-DD calendar date as "Nov 30". */
export const calendarDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** "Today" or "Sep 18", for when a deal closed. */
export function dayLabel(iso: string, now: number) {
  const date = new Date(iso);
  if (isSameDay(date, new Date(now))) return "Today";
  if (isSameDay(date, new Date(now - DAY))) return "Yesterday";
  return shortDate(iso);
}

/** "just now", "12m ago", "3h ago", "Yesterday", "4d ago", then a date. */
export function relativeTime(iso: string, now: number) {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days}d ago`;
  return shortDate(iso);
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? [parts[0]![0], parts[parts.length - 1]![0]] : [parts[0]?.[0], parts[0]?.[1]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
}

/** Local start of the calendar quarter containing `now`. */
export function quarterStart(now: number) {
  const date = new Date(now);
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1).getTime();
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(time: number) {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses "$48,000", "48000" or "48k" into whole dollars; "" is no value. */
export function parseMoney(text: string): number | null | "invalid" {
  const compact = text
    .trim()
    .replace(/[$,\s]/g, "")
    .toLowerCase();
  if (compact === "") return null;
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(compact);
  if (match === null) return "invalid";
  const value = Number(match[1]) * (match[2] === "k" ? 1000 : match[2] === "m" ? 1_000_000 : 1);
  return Number.isInteger(value) ? value : "invalid";
}
