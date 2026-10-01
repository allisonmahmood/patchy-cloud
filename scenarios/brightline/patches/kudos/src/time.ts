import { useEffect, useState } from "patchy/preact";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The wall clock, re-read every `everyMs` so relative times and rolling windows stay current. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Start of the local day `days` days before `now`, as an ISO timestamp (stable for a whole day). */
export function daysAgoStart(now: number, days: number): string {
  const start = new Date(now - days * DAY);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

/** "just now", "12 min ago", "3 hours ago", "Yesterday", "4 days ago", then a short date. */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso);
  const diff = Math.max(0, now - then.getTime());
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((today.getTime() - then.getTime()) / DAY);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() === today.getFullYear() ? {} : { year: "numeric" })
  });
}

export const fullDate = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
