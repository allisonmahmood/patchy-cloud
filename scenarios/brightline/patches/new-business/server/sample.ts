// "Load sample data" for an empty board: realistic Brightline deals with backdated history,
// owned by whoever is currently in the member directory.
import { HandlerError, mutation, t } from "../patchy/_generated/server.js";
import type { LostReason, Service, Source, Stage } from "../helpers/pipeline.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Days ago, or hours ago squeezed into the current quarter so "Won this quarter" has wins. */
type When = number | { readonly hoursAgoThisQuarter: number };

interface SampleDeal {
  readonly client: string;
  readonly title: string;
  readonly service: Service;
  readonly value: number | null;
  readonly source: Source;
  readonly nextStep: string | null;
  /** Expected close, in days from today. */
  readonly closeInDays: number | null;
  /** Index into the member directory; null leaves the deal unassigned. */
  readonly owner: number | null;
  readonly creator: number;
  readonly openedDaysAgo: number;
  /** Stages entered after Lead, oldest first. */
  readonly path: readonly (readonly [Stage, When])[];
  /** Why it was lost, when the path ends in Lost. */
  readonly lostReason?: LostReason;
  readonly notes?: readonly (readonly [When, string])[];
  readonly edit?: readonly [When, string];
}

const SAMPLE: readonly SampleDeal[] = [
  // Lead
  {
    client: "Saltwater Hotels",
    title: "Loyalty app concept",
    service: "Product design",
    value: 48000,
    source: "Inbound",
    nextStep: "Intro call with their digital lead",
    closeInDays: 45,
    owner: 4,
    creator: 4,
    openedDaysAgo: 3.2,
    path: [],
    notes: [
      [
        3.1,
        "Came in through the website form. Three coastal properties; they want a loyalty app that ties stays to local partners."
      ]
    ]
  },
  {
    client: "Verdant Grocers",
    title: "Seasonal campaign",
    service: "Campaign",
    value: 35000,
    source: "Outbound",
    nextStep: "Send our capabilities deck",
    closeInDays: 40,
    owner: 1,
    creator: 1,
    openedDaysAgo: 6.4,
    path: [],
    notes: [
      [
        5.9,
        "Cold email landed a call with their marketing director. Spring produce campaign across 40 stores."
      ]
    ]
  },
  {
    client: "Parkside Dental Group",
    title: "Website refresh",
    service: "Website",
    value: 22000,
    source: "Inbound",
    nextStep: null,
    closeInDays: null,
    owner: null,
    creator: 0,
    openedDaysAgo: 1.3,
    path: []
  },
  {
    client: "Copperline Ceramics",
    title: "Online shop launch",
    service: "Website",
    value: null,
    source: "Referral",
    nextStep: "Get an intro through Fieldnote Press",
    closeInDays: null,
    owner: null,
    creator: 3,
    openedDaysAgo: 2.1,
    path: [],
    notes: [
      [
        2.0,
        "Referred by Fieldnote Press. Small studio that wants to sell online before the holidays."
      ]
    ]
  },
  // Discovery
  {
    client: "Kestrel Health",
    title: "Patient portal UX",
    service: "Product design",
    value: 120000,
    source: "Referral",
    nextStep: "Scope workshop with their patient experience team",
    closeInDays: 35,
    owner: 2,
    creator: 0,
    openedDaysAgo: 16.5,
    path: [["discovery", 9.3]],
    notes: [
      [
        8.8,
        "Great first call. They want the portal redesign in two phases, and phase one already has budget."
      ],
      [4.2, "Shared two case studies from our health work. They asked for a workshop plan."]
    ]
  },
  {
    client: "Fieldnote Press",
    title: "Brand refresh",
    service: "Brand identity",
    value: 40000,
    source: "Existing client",
    nextStep: "Audit their current brand assets",
    closeInDays: 30,
    owner: 3,
    creator: 3,
    openedDaysAgo: 11.2,
    path: [["discovery", 4.1]],
    notes: [[4.0, "They want the refresh ready for the press's 25th anniversary in the spring."]]
  },
  {
    client: "Tidewater Rowing Club",
    title: "Membership drive",
    service: "Campaign",
    value: 18000,
    source: "Inbound",
    nextStep: "Confirm budget with their board",
    closeInDays: 28,
    owner: 0,
    creator: 1,
    openedDaysAgo: 13.6,
    path: [["discovery", 7.2]]
  },
  // Proposal
  {
    client: "Northline Bikes",
    title: "Spring launch campaign",
    service: "Campaign",
    value: 85000,
    source: "Outbound",
    nextStep: "Follow up after their board meeting",
    closeInDays: 14,
    owner: 1,
    creator: 1,
    openedDaysAgo: 27.4,
    path: [
      ["discovery", 19.5],
      ["proposal", 5.2]
    ],
    notes: [[5.1, "Proposal deck sent. Decision expected after their board meeting next Thursday."]]
  },
  {
    client: "Mosaic Credit Union",
    title: "New brand identity",
    service: "Brand identity",
    value: 64000,
    source: "Referral",
    nextStep: "Answer their compliance questions",
    closeInDays: 21,
    owner: 0,
    creator: 2,
    openedDaysAgo: 33.3,
    path: [
      ["discovery", 24.6],
      ["proposal", 12.1]
    ],
    edit: [12.4, "value $58,000 → $64,000"],
    notes: [[11.8, "Proposal sent. Their compliance review usually takes about two weeks."]]
  },
  {
    client: "Orchard & Vine",
    title: "Content retainer, Q1",
    service: "Content",
    value: 30000,
    source: "Existing client",
    nextStep: "Walk them through the content calendar",
    closeInDays: 10,
    owner: 3,
    creator: 3,
    openedDaysAgo: 9.5,
    path: [
      ["discovery", 6.3],
      ["proposal", 2.2]
    ]
  },
  // Negotiation
  {
    client: "Atlas Outdoor Co.",
    title: "E-commerce rebuild",
    service: "Website",
    value: 140000,
    source: "Referral",
    nextStep: "Send a revised timeline with two releases",
    closeInDays: 9,
    owner: 2,
    creator: 2,
    openedDaysAgo: 38.2,
    path: [
      ["discovery", 30.5],
      ["proposal", 17.3],
      ["negotiation", 3.1]
    ],
    notes: [
      [16.9, "Proposal walkthrough went well. They loved the product-finder concept."],
      [2.9, "They pushed back on the timeline. Offered to split the build into two releases."]
    ]
  },
  {
    client: "Bluebird Pediatrics",
    title: "Clinic signage and wayfinding",
    service: "Brand identity",
    value: 26000,
    source: "Inbound",
    nextStep: "Agree on a start date",
    closeInDays: 7,
    owner: 4,
    creator: 0,
    openedDaysAgo: 25.7,
    path: [
      ["discovery", 20.2],
      ["proposal", 13.4],
      ["negotiation", 8.2]
    ]
  },
  // Won
  {
    client: "Harbor & Pine Coffee",
    title: "Rebrand and packaging",
    service: "Brand identity",
    value: 92000,
    source: "Referral",
    nextStep: "Book the kickoff workshop",
    closeInDays: null,
    owner: 3,
    creator: 0,
    openedDaysAgo: 41.3,
    path: [
      ["discovery", 34.2],
      ["proposal", 22.6],
      ["negotiation", 10.4],
      ["won", { hoursAgoThisQuarter: 5 }]
    ],
    notes: [
      [{ hoursAgoThisQuarter: 4.8 }, "Signed! Kickoff workshop is pencilled in for next week."]
    ]
  },
  {
    client: "Lumen Labs",
    title: "Content retainer",
    service: "Content",
    value: 36000,
    source: "Existing client",
    nextStep: "Set up the monthly content review",
    closeInDays: null,
    owner: 4,
    creator: 4,
    openedDaysAgo: 29.1,
    path: [
      ["discovery", 23.5],
      ["proposal", 15.2],
      ["negotiation", 6.3],
      ["won", { hoursAgoThisQuarter: 2.5 }]
    ]
  },
  {
    client: "Granite Peak Brewing",
    title: "Label system",
    service: "Brand identity",
    value: 28000,
    source: "Inbound",
    nextStep: null,
    closeInDays: null,
    owner: 1,
    creator: 1,
    openedDaysAgo: 60.4,
    path: [
      ["discovery", 54.2],
      ["proposal", 46.1],
      ["negotiation", 41.3],
      ["won", 36.2]
    ],
    notes: [[36.1, "Signed for six core labels plus seasonal templates."]]
  },
  // Lost
  {
    client: "Meridian Freight",
    title: "Investor website",
    service: "Website",
    value: 55000,
    source: "Outbound",
    nextStep: null,
    closeInDays: null,
    owner: 0,
    creator: 0,
    openedDaysAgo: 34.5,
    path: [
      ["discovery", 28.3],
      ["proposal", 21.4],
      ["lost", 15.2]
    ],
    lostReason: "Chose another agency",
    notes: [[21.2, "Proposal sent along with two homepage directions."]]
  },
  {
    client: "Solstice Yoga Studios",
    title: "Booking app prototype",
    service: "Product design",
    value: 44000,
    source: "Inbound",
    nextStep: null,
    closeInDays: null,
    owner: 2,
    creator: 2,
    openedDaysAgo: 40.2,
    path: [
      ["discovery", 33.6],
      ["proposal", 27.1],
      ["lost", 22.4]
    ],
    lostReason: "Budget"
  }
];

/** Rule 7: fills an empty board. Refuses once any deal exists, so it never mixes with real work. */
export const load = mutation({
  args: {},
  errors: ["not_empty"],
  result: t.object({ deals: t.integer(), events: t.integer() }),
  handler: async (ctx) => {
    const existing = await ctx.tables.deals.list({ limit: 1 });
    if (existing.rows.length > 0) throw new HandlerError("not_empty", {});

    const candidates = (await ctx.members.list()).rows
      .filter((member) => member.active)
      .map((member) => member.id);
    const people = candidates.length > 0 ? candidates : [ctx.viewer.user.id];
    const person = (slot: number) => people[slot % people.length]!;

    const now = Date.now();
    const quarterStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      Math.floor(new Date(now).getUTCMonth() / 3) * 3,
      1
    );
    // Up to six hours of "today" that still fall inside the current quarter.
    const span = Math.min(6 * HOUR, (now - quarterStart) * 0.9);
    const at = (when: When) =>
      new Date(
        typeof when === "number" ? now - when * DAY : now - (when.hoursAgoThisQuarter / 6) * span
      ).toISOString();
    const dateIn = (days: number) => new Date(now + days * DAY).toISOString().slice(0, 10);

    const deals = await ctx.tables.deals.insertMany(
      SAMPLE.map((deal) => {
        const opened = at(deal.openedDaysAgo);
        const stageEntered =
          deal.path.length > 0 ? at(deal.path[deal.path.length - 1]![1]) : opened;
        const times = [stageEntered, ...(deal.notes ?? []).map(([when]) => at(when))];
        return {
          client: deal.client,
          title: deal.title,
          service: deal.service,
          value: deal.value,
          stage: deal.path.length > 0 ? deal.path[deal.path.length - 1]![0] : "lead",
          owner: deal.owner === null ? null : person(deal.owner),
          source: deal.source,
          nextStep: deal.nextStep,
          expectedClose: deal.closeInDays === null ? null : dateIn(deal.closeInDays),
          lostReason: deal.lostReason ?? null,
          openedAt: opened,
          stageEnteredAt: stageEntered,
          lastActivityAt: times.sort().at(-1)!
        };
      })
    );

    const events = SAMPLE.flatMap((sample, index) => {
      const deal = deals[index]!;
      const creator = person(sample.creator);
      const actor = deal.owner ?? creator;
      const openedMs = Date.parse(deal.openedAt);
      const rows = [
        { deal: deal.id, kind: "created", actor: creator, toStage: "lead", at: deal.openedAt },
        ...(deal.owner === null
          ? []
          : [
              {
                deal: deal.id,
                kind: "assigned",
                actor: creator,
                assignee: deal.owner,
                at: new Date(openedMs + 40 * 60_000).toISOString()
              }
            ]),
        ...sample.path.map(([stage, when], step) => ({
          deal: deal.id,
          kind: "moved",
          actor,
          fromStage: step === 0 ? "lead" : sample.path[step - 1]![0],
          toStage: stage,
          note: stage === "lost" ? (sample.lostReason ?? null) : null,
          at: at(when)
        })),
        ...(sample.notes ?? []).map(([when, note]) => ({
          deal: deal.id,
          kind: "note",
          actor,
          note,
          at: at(when)
        })),
        ...(sample.edit === undefined
          ? []
          : [
              { deal: deal.id, kind: "edited", actor, note: sample.edit[1], at: at(sample.edit[0]) }
            ])
      ];
      return rows;
    });
    await ctx.tables.activity.insertMany(events);
    return { deals: deals.length, events: events.length };
  }
});
