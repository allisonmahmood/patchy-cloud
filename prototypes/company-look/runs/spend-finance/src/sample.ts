import type { Insert } from "patchy/config";
import type config from "../patchy.config.js";

type RequestInsert = Insert<typeof config, "requests">;

const DAY = 24 * 60 * 60 * 1000;

const rows: readonly {
  title: string;
  vendor: string;
  amount: number;
  category: string;
  requestedBy: string;
  daysAgo: number;
  status: "Pending" | "Approved" | "Rejected";
  decidedBy?: string;
  note?: string;
}[] = [
  {
    title: "Customer dinner",
    vendor: "Lucia's",
    amount: 312,
    category: "Other",
    requestedBy: "Sam Patel",
    daysAgo: 0,
    status: "Pending"
  },
  {
    title: "Flights for the Berlin visit",
    vendor: "Lufthansa",
    amount: 860,
    category: "Travel",
    requestedBy: "Jordan Lee",
    daysAgo: 1,
    status: "Pending"
  },
  {
    title: "Figma seats renewal",
    vendor: "Figma",
    amount: 1440,
    category: "Software",
    requestedBy: "Maya Chen",
    daysAgo: 2,
    status: "Pending"
  },
  {
    title: "React Summit tickets",
    vendor: "React Summit",
    amount: 1180,
    category: "Events",
    requestedBy: "Priya Nair",
    daysAgo: 3,
    status: "Pending"
  },
  {
    title: "Replacement laptop charger",
    vendor: "Apple",
    amount: 79,
    category: "Equipment",
    requestedBy: "Maya Chen",
    daysAgo: 5,
    status: "Approved",
    decidedBy: "Jordan Lee"
  },
  {
    title: "Offsite venue deposit",
    vendor: "Harbor Hall",
    amount: 3200,
    category: "Events",
    requestedBy: "Priya Nair",
    daysAgo: 9,
    status: "Approved",
    decidedBy: "Sam Patel",
    note: "Keep the total under $3,500."
  },
  {
    title: "Standing desks for new hires",
    vendor: "Fully",
    amount: 2150,
    category: "Equipment",
    requestedBy: "Jordan Lee",
    daysAgo: 12,
    status: "Rejected",
    decidedBy: "Sam Patel",
    note: "Wait for the office move."
  },
  {
    title: "Notion team plan",
    vendor: "Notion",
    amount: 480,
    category: "Software",
    requestedBy: "Sam Patel",
    daysAgo: 20,
    status: "Approved",
    decidedBy: "Maya Chen"
  }
];

/** The eight invented sample requests, dated relative to `now`. */
export function sampleRequests(now: number): RequestInsert[] {
  return rows.map((row) => {
    const requestedAt = now - row.daysAgo * DAY;
    // Sample decisions land a few hours after the request, never in the future.
    const decidedAt = row.decidedBy ? Math.min(now, requestedAt + 4 * 60 * 60 * 1000) : null;
    return {
      title: row.title,
      vendor: row.vendor,
      amountCents: row.amount * 100,
      category: row.category,
      reason: "",
      requestedBy: row.requestedBy,
      requestedById: null,
      requestedAt: new Date(requestedAt).toISOString(),
      status: row.status,
      decidedBy: row.decidedBy ?? null,
      decidedById: null,
      decidedAt: decidedAt === null ? null : new Date(decidedAt).toISOString(),
      note: row.note ?? null
    };
  });
}
