// Invented people and requests for the empty state's "Load sample data" button.
const DAY = 86_400_000;

type Sample = [
  title: string,
  vendor: string,
  dollars: number,
  category: string,
  requester: string,
  daysAgo: number,
  status: "pending" | "approved" | "rejected",
  decider: string,
  note: string
];

const SAMPLES: readonly Sample[] = [
  ["Customer dinner", "Lucia's", 312, "Other", "Sam Patel", 0, "pending", "", ""],
  ["Flights for the Berlin visit", "Lufthansa", 860, "Travel", "Jordan Lee", 1, "pending", "", ""],
  ["Figma seats renewal", "Figma", 1440, "Software", "Maya Chen", 2, "pending", "", ""],
  ["React Summit tickets", "React Summit", 1180, "Events", "Priya Nair", 3, "pending", "", ""],
  [
    "Replacement laptop charger",
    "Apple",
    79,
    "Equipment",
    "Maya Chen",
    5,
    "approved",
    "Jordan Lee",
    ""
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
  ["Notion team plan", "Notion", 480, "Software", "Sam Patel", 20, "approved", "Maya Chen", ""]
];

export function sampleRequests(now: number) {
  return SAMPLES.map(
    ([title, vendor, dollars, category, requester, daysAgo, status, decider, note]) => {
      const requested = now - daysAgo * DAY;
      return {
        title,
        vendor,
        amountCents: dollars * 100,
        category,
        reason: "",
        requesterId: null,
        requesterName: requester,
        requestedAt: new Date(requested).toISOString(),
        status,
        deciderId: null,
        deciderName: decider || null,
        decisionNote: note || null,
        // The brief gives no decision dates; assume each was decided a day after it was asked.
        decidedAt:
          status === "pending" ? null : new Date(Math.min(requested + DAY, now)).toISOString()
      };
    }
  );
}
