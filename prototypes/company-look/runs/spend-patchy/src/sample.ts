import type { Insert } from "patchy/config";
import type config from "../patchy.config.js";

type Sample = [
  title: string,
  vendor: string,
  dollars: number,
  category: string,
  by: string,
  daysAgo: number,
  status: "pending" | "approved" | "rejected",
  decidedBy?: string,
  note?: string
];

const SAMPLES: readonly Sample[] = [
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

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The eight invented sample requests, dated relative to `now`. Decisions land a few hours after the request. */
export function sampleRequests(now: number): Insert<typeof config, "requests">[] {
  return SAMPLES.map(
    ([title, vendor, dollars, category, by, daysAgo, status, decidedBy, note], i) => {
      // Today's row is "just now"; stagger by index so same-day ordering stays stable.
      const requestedAt = now - daysAgo * DAY - i * 60_000;
      const decidedAt = status === "pending" ? null : Math.min(now, requestedAt + 4 * HOUR);
      return {
        title,
        vendor,
        amountCents: dollars * 100,
        category,
        reason: null,
        requestedByName: by,
        requestedById: null,
        requestedAt: new Date(requestedAt).toISOString(),
        status,
        decidedByName: decidedBy ?? null,
        decidedById: null,
        decidedAt: decidedAt === null ? null : new Date(decidedAt).toISOString(),
        note: note ?? null
      };
    }
  );
}
