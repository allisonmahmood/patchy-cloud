import type { Insert, Row } from "patchy/config";
import type config from "../patchy.config.js";

export type Request = Row<typeof config, "requests">;
export type NewRequest = Insert<typeof config, "requests">;
export type Status = "pending" | "approved" | "rejected";

export const CATEGORIES = ["Software", "Travel", "Equipment", "Events", "Other"] as const;

export const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected"
};

const DAY = 86_400_000;

const wholeDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const centDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2
});

/** "$1,440" for whole dollars, "$145.50" otherwise. */
export function formatCents(cents: number): string {
  return (cents % 100 === 0 ? wholeDollars : centDollars).format(cents / 100);
}

/** Parses "1,234.50" or "$80" into integer cents, or null when it isn't a positive amount. */
export function parseDollars(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 ? cents : null;
}

export function relativeDay(iso: string, now: number): string {
  const then = new Date(iso);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(then)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function monthStartIso(now: number): string {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

type Sample = [string, string, number, string, string, number, Status, string?, string?];

const SAMPLES: Sample[] = [
  ["Customer dinner", "Lucia's", 312, "Other", "Sam Patel", 0, "pending"],
  ["Flights for the Berlin visit", "Lufthansa", 860, "Travel", "Jordan Lee", 1, "pending"],
  ["Figma seats renewal", "Figma", 1440, "Software", "Maya Chen", 2, "pending"],
  ["React Summit tickets", "React Summit", 1180, "Events", "Priya Nair", 3, "pending"],
  [
    "Replacement laptop charger",
    "Apple",
    79,
    "Equipment",
    "Maya Chen",
    5,
    "approved",
    "Jordan Lee"
  ],
  [
    "Offsite venue deposit",
    "Harbor Hall",
    3200,
    "Events",
    "Priya Nair",
    9,
    "approved",
    "Sam Patel",
    "Keep the total under $3,500."
  ],
  [
    "Standing desks for new hires",
    "Fully",
    2150,
    "Equipment",
    "Jordan Lee",
    12,
    "rejected",
    "Sam Patel",
    "Wait for the office move."
  ],
  ["Notion team plan", "Notion", 480, "Software", "Sam Patel", 20, "approved", "Maya Chen"]
];

const SAMPLE_REASONS: Record<string, string> = {
  "Customer dinner": "Dinner with the Acme team after the renewal call.",
  "Flights for the Berlin visit": "Return flights for the partner workshop.",
  "Figma seats renewal": "Annual renewal for the design team's six seats.",
  "React Summit tickets": "Two tickets for the frontend team.",
  "Replacement laptop charger": "My charger stopped working.",
  "Offsite venue deposit": "Deposit to hold the venue for the team offsite.",
  "Standing desks for new hires": "Desks for the three people starting next month.",
  "Notion team plan": "Move the team wiki to the paid plan."
};

/** The eight invented sample requests, dated relative to `now`. Decisions land a day after the ask. */
export function sampleRows(now: number): NewRequest[] {
  return SAMPLES.map(([title, vendor, amount, category, by, daysAgo, status, decidedBy, note]) => {
    const requestedAt = now - daysAgo * DAY;
    const decided = status !== "pending";
    return {
      title,
      vendor,
      amountCents: amount * 100,
      category,
      reason: SAMPLE_REASONS[title] ?? "",
      requestedById: null,
      requestedByName: by,
      requestedAt: new Date(requestedAt).toISOString(),
      status,
      decidedById: null,
      decidedByName: decided ? (decidedBy ?? null) : null,
      decidedAt: decided ? new Date(Math.min(now, requestedAt + DAY)).toISOString() : null,
      note: note ?? null
    };
  });
}
