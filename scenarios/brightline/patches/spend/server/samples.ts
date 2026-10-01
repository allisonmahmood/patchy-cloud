import { action, HandlerError, mutation, t } from "../patchy/_generated/server.js";
import type { MutationContext } from "../patchy/_generated/server.js";
import type { Member } from "patchy/client";
import {
  adminApprovalCents,
  formatMoney,
  refusals,
  type Category,
  type Status
} from "../helpers/spend.js";

// "Load sample data" for an empty tool: realistic Brightline Studio requests,
// spread over the member directory and backdated over the last six weeks.

interface Receipt {
  readonly vendor: string;
  readonly address: string;
  readonly kind: "Receipt" | "Invoice" | "Quote";
  readonly number: string;
  readonly items: readonly (readonly [string, number])[];
  readonly footer: string;
}

interface Sample {
  readonly title: string;
  readonly project: string;
  readonly category: Category;
  /** Integer cents; requests with a receipt use the receipt's total instead. */
  readonly amountCents?: number;
  readonly status: Status;
  /** Requester position in the candidate list, so people are spread evenly. */
  readonly slot: number;
  readonly daysAgo: number;
  readonly decidedAfter?: number;
  readonly paidAfter?: number;
  readonly decisionNote?: string;
  readonly receipt?: Receipt & { readonly file: string };
  readonly notes?: readonly {
    readonly after: number;
    readonly byRequester: boolean;
    readonly text: string;
  }[];
}

const samples: readonly Sample[] = [
  {
    title: "Figma Organization renewal (10 seats)",
    project: "Studio",
    category: "Software",
    status: "paid",
    slot: 0,
    daysAgo: 24,
    decidedAfter: 0.8,
    paidAfter: 2.2,
    decisionNote: "Renewal held at last year's rate.",
    receipt: {
      file: "figma-invoice.svg",
      vendor: "Figma, Inc.",
      address: "760 Market St, San Francisco, CA",
      kind: "Invoice",
      number: "INV-2026-48213",
      items: [["Organization plan · 10 seats × 12 months", 5_400_00]],
      footer: "Paid · Visa ending 4821"
    }
  },
  {
    title: "Motion designer for the launch film",
    project: "Northline Bikes",
    category: "Freelancer",
    status: "approved",
    slot: 1,
    daysAgo: 12,
    decidedAfter: 0.9,
    decisionNote: "Approved. Book her for the week of the 14th.",
    receipt: {
      file: "juno-okafor-quote.svg",
      vendor: "Juno Okafor Motion",
      address: "Studio 4, 112 Alder St, Portland, OR",
      kind: "Quote",
      number: "Q-0187",
      items: [
        ["Animation & compositing · 5 days × $650", 3_250_00],
        ["Sound design & final mix", 500_00]
      ],
      footer: "Quote valid for 30 days"
    },
    notes: [{ after: 2.5, byRequester: true, text: "Booked. Kick-off is Monday at 10." }]
  },
  {
    title: "Product shoot: studio hire & prop styling",
    project: "Harbor & Pine Coffee",
    category: "Production",
    status: "submitted",
    slot: 2,
    daysAgo: 2,
    receipt: {
      file: "northside-studios-quote.svg",
      vendor: "Northside Studios",
      address: "48 Foundry Way, Portland, OR",
      kind: "Quote",
      number: "NS-3391",
      items: [
        ["Studio hire · full day (10 hrs)", 1_200_00],
        ["Prop styling incl. props", 780_00],
        ["Lighting package", 200_00]
      ],
      footer: "Holding the date until Thursday"
    },
    notes: [
      {
        after: 0.1,
        byRequester: true,
        text: "They're holding the date until Thursday, so a quick yes would help."
      }
    ]
  },
  {
    title: "Flights to Denver for the Atlas workshop",
    project: "Atlas Outdoor Co.",
    category: "Travel",
    status: "approved",
    slot: 3,
    daysAgo: 9,
    decidedAfter: 0.4,
    receipt: {
      file: "summit-air-receipt.svg",
      vendor: "Summit Air",
      address: "Booking ref. K7Q2LM",
      kind: "Receipt",
      number: "0162-4471-0093",
      items: [
        ["PDX → DEN round trip × 2, main cabin", 1_148_00],
        ["Seat selection × 2", 64_00],
        ["Checked bag (workshop kit)", 52_80]
      ],
      footer: "Paid · Amex ending 1007"
    }
  },
  {
    title: "Sony FE 85mm f/1.8 lens",
    project: "Studio",
    category: "Equipment",
    status: "rejected",
    slot: 4,
    daysAgo: 20,
    decidedAfter: 1.1,
    decisionNote: "We already have an 85mm in the kit room. Book it on the equipment sheet.",
    receipt: {
      file: "lensworks-quote.svg",
      vendor: "Lensworks Camera Supply",
      address: "2210 SE Division St, Portland, OR",
      kind: "Quote",
      number: "LW-55018",
      items: [
        ["Sony FE 85mm F1.8 (SEL85F18)", 599_99],
        ["67mm UV filter", 50_00]
      ],
      footer: "Prices held for 7 days"
    }
  },
  {
    title: "Stock photos for the patient portal",
    project: "Kestrel Health",
    category: "Other",
    amountCents: 299_00,
    status: "paid",
    slot: 1,
    daysAgo: 27,
    decidedAfter: 0.3,
    paidAfter: 3
  },
  {
    title: "Usability test participants (8 × $75)",
    project: "Kestrel Health",
    category: "Other",
    status: "submitted",
    slot: 0,
    daysAgo: 3,
    receipt: {
      file: "panelist-quote.svg",
      vendor: "Panelist Research Co.",
      address: "panelist.example · Seattle, WA",
      kind: "Quote",
      number: "PR-2209",
      items: [["Participant incentives · 8 × $75.00", 600_00]],
      footer: "Sessions run Oct 8–9"
    }
  },
  {
    title: "Hotel for the Saltwater site visit (2 nights)",
    project: "Saltwater Hotels",
    category: "Travel",
    amountCents: 438_20,
    status: "submitted",
    slot: 3,
    daysAgo: 1
  },
  {
    title: "Copywriter: packaging & menu board copy",
    project: "Verdant Grocers",
    category: "Freelancer",
    status: "submitted",
    slot: 1,
    daysAgo: 4,
    receipt: {
      file: "lindqvist-quote.svg",
      vendor: "Mara Lindqvist Copy",
      address: "mara@lindqvist.example",
      kind: "Quote",
      number: "ML-041",
      items: [
        ["Packaging copy · 6 SKUs", 1_200_00],
        ["In-store menu board copy", 600_00]
      ],
      footer: "50% on start, 50% on delivery"
    }
  },
  {
    title: "Frame.io Team plan (3 months)",
    project: "Studio",
    category: "Software",
    amountCents: 225_00,
    status: "approved",
    slot: 2,
    daysAgo: 15,
    decidedAfter: 0.2
  },
  {
    title: "Illustrator: six campaign spot illustrations",
    project: "Mosaic Credit Union",
    category: "Freelancer",
    status: "submitted",
    slot: 4,
    daysAgo: 5,
    receipt: {
      file: "pell-grove-quote.svg",
      vendor: "Pell & Grove Illustration",
      address: "hello@pellgrove.example",
      kind: "Quote",
      number: "PG-1126",
      items: [
        ["Spot illustrations · 6 × $600", 3_600_00],
        ["Usage licence · 12 months, digital & OOH", 600_00]
      ],
      footer: "Two rounds of revisions included"
    },
    notes: [
      {
        after: 1.2,
        byRequester: false,
        text: "Can we add print usage? Mosaic may want branch posters."
      }
    ]
  },
  {
    title: "Photographer: hotel lobby & suites shoot",
    project: "Saltwater Hotels",
    category: "Production",
    status: "submitted",
    slot: 1,
    daysAgo: 1,
    receipt: {
      file: "ines-varga-quote.svg",
      vendor: "Ines Varga Photography",
      address: "ines@varga.example · Portland, OR",
      kind: "Quote",
      number: "IV-2026-31",
      items: [
        ["Day rate · interiors", 1_950_00],
        ["Retouching · 25 selects", 625_00],
        ["Photo assistant", 275_00]
      ],
      footer: "Quote valid for 14 days"
    }
  },
  {
    title: "Team lunch at the Lumen Labs kickoff",
    project: "Lumen Labs",
    category: "Other",
    amountCents: 186_40,
    status: "paid",
    slot: 2,
    daysAgo: 6,
    decidedAfter: 0.1,
    paidAfter: 2.6
  },
  {
    title: "External SSDs for the project archive (2 × 4TB)",
    project: "Studio",
    category: "Equipment",
    status: "approved",
    slot: 3,
    daysAgo: 7,
    decidedAfter: 1.4,
    receipt: {
      file: "circuit-co-receipt.svg",
      vendor: "Circuit & Co.",
      address: "Order #CC-88412 · circuitco.example",
      kind: "Receipt",
      number: "CC-88412",
      items: [["Samsung T7 Shield 4TB × 2", 518_00]],
      footer: "Paid · Visa ending 4821"
    }
  },
  {
    title: "Rideshare to the Parkside shoot",
    project: "Parkside Dental Group",
    category: "Travel",
    amountCents: 64_30,
    status: "rejected",
    slot: 1,
    daysAgo: 10,
    decidedAfter: 0.5,
    decisionNote: "Please use the studio car account for shoots. It's already set up for Parkside."
  }
];

const totalOf = (receipt: Receipt) => receipt.items.reduce((sum, [, cents]) => sum + cents, 0);

const escapeXml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char
  );

/** A clean paper-style receipt or quote, as SVG, so the preview looks like a real scan. */
function receiptSvg(receipt: Receipt, project: string, date: Date): string {
  const width = 520;
  const rowHeight = 30;
  const itemsTop = 282;
  const totalsTop = itemsTop + receipt.items.length * rowHeight + 22;
  const height = totalsTop + 150;
  const total = totalOf(receipt);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const text = (x: number, y: number, value: string, attrs = "") =>
    `<text x="${x}" y="${y}" ${attrs}>${escapeXml(value)}</text>`;
  const isQuote = receipt.kind === "Quote";
  const rows = receipt.items
    .map(([label, cents], index) => {
      const y = itemsTop + index * rowHeight;
      return (
        text(36, y, label, 'font-size="14" fill="#2A2A2A"') +
        text(width - 36, y, formatMoney(cents), 'font-size="14" fill="#2A2A2A" text-anchor="end"')
      );
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
<rect width="${width}" height="${height}" fill="#FBFAF6"/>
<rect x="0" y="0" width="${width}" height="8" fill="${isQuote ? "#1F2A44" : "#14532D"}"/>
${text(36, 66, receipt.vendor, 'font-size="24" font-weight="700" fill="#111"')}
${text(36, 90, receipt.address, 'font-size="12.5" fill="#6B6B6B"')}
${text(width - 36, 62, receipt.kind.toUpperCase(), 'font-size="13" font-weight="700" letter-spacing="3" fill="#111" text-anchor="end"')}
${text(width - 36, 84, `No. ${receipt.number}`, 'font-size="12.5" fill="#6B6B6B" text-anchor="end"')}
${text(width - 36, 102, day, 'font-size="12.5" fill="#6B6B6B" text-anchor="end"')}
<line x1="36" y1="130" x2="${width - 36}" y2="130" stroke="#E2E0DA"/>
${text(36, 160, isQuote ? "PREPARED FOR" : "BILLED TO", 'font-size="11" font-weight="700" letter-spacing="1.5" fill="#8A8A8A"')}
${text(36, 182, "Brightline Studio", 'font-size="15" font-weight="600" fill="#111"')}
${text(36, 201, project === "Studio" ? "Studio operations" : `Project: ${project}`, 'font-size="12.5" fill="#6B6B6B"')}
${text(36, itemsTop - 30, "DESCRIPTION", 'font-size="11" font-weight="700" letter-spacing="1.5" fill="#8A8A8A"')}
${text(width - 36, itemsTop - 30, "AMOUNT", 'font-size="11" font-weight="700" letter-spacing="1.5" fill="#8A8A8A" text-anchor="end"')}
${rows}
<line x1="36" y1="${totalsTop - 8}" x2="${width - 36}" y2="${totalsTop - 8}" stroke="#E2E0DA"/>
${text(36, totalsTop + 22, isQuote ? "Quoted total" : "Total", 'font-size="15" font-weight="700" fill="#111"')}
${text(width - 36, totalsTop + 22, formatMoney(total), 'font-size="20" font-weight="700" fill="#111" text-anchor="end"')}
${text(36, totalsTop + 50, "USD · tax included where applicable", 'font-size="11.5" fill="#8A8A8A"')}
<rect x="36" y="${totalsTop + 76}" width="${width - 72}" height="40" rx="6" fill="${isQuote ? "#EEF1F8" : "#ECF6EF"}"/>
${text(width / 2, totalsTop + 101, receipt.footer, `font-size="13" font-weight="600" fill="${isQuote ? "#1F2A44" : "#14532D"}" text-anchor="middle"`)}
</svg>`;
}

const day = 24 * 60 * 60 * 1000;
const sampleFile = (file: string) => `samples/${file}`;

/**
 * Who asked, who decided and who paid, spread over the directory and following
 * the real rules: nobody decides their own request, $2,500 or more is approved
 * by an admin, and only admins pay. A sample that can't be cast honestly with
 * the current people stays submitted.
 */
function cast(people: readonly Member[], sample: Sample, index: number, amountCents: number) {
  const admins = people.filter((person) => person.admin);
  const needsAdmin =
    amountCents >= adminApprovalCents && (sample.status === "approved" || sample.status === "paid");
  let requester: Member | undefined = people[sample.slot % people.length];
  // With a single admin, a big approved request has to come from someone else.
  if (needsAdmin && requester?.admin === true && admins.length === 1)
    requester = people.find((person) => !person.admin) ?? requester;
  const others = people.filter((person) => person.id !== requester?.id);
  const approver: Member | undefined = needsAdmin
    ? others.find((person) => person.admin)
    : others[(index + sample.slot) % Math.max(others.length, 1)];
  const payer: Member | undefined = others.find((person) => person.admin) ?? admins[0];
  const status: Status =
    sample.status === "submitted" || approver === undefined
      ? "submitted"
      : sample.status === "paid" && payer === undefined
        ? "approved"
        : sample.status;
  return { requester, approver, payer, status };
}

/** Every active candidate, following directory pages. */
async function candidates(ctx: MutationContext) {
  const all = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.members.list(cursor === undefined ? undefined : { cursor });
    all.push(...page.rows);
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return all;
}

/**
 * Insert every sample request and its backdated audit trail in one transaction.
 * Refuses unless the tool is empty. Run by the load action after it stores the
 * sample receipts; the rows follow the same rules as real requests.
 */
export const seed = mutation({
  args: {},
  result: t.object({ requests: t.integer() }),
  errors: ["not_empty"],
  handler: async (ctx) => {
    const existing = await ctx.tables.requests.list({ limit: 1 });
    if (existing.rows.length > 0)
      throw new HandlerError("not_empty", { message: refusals.not_empty });
    const people = await candidates(ctx);
    const now = Date.now();
    let inserted = 0;

    for (const [index, sample] of samples.entries()) {
      const amountCents =
        sample.receipt === undefined ? (sample.amountCents ?? 0) : totalOf(sample.receipt);
      const { requester, approver, payer, status } = cast(people, sample, index, amountCents);
      if (requester === undefined) break;

      const jitter = ((index * 7) % 9) * 60 * 60 * 1000;
      const submittedAt = now - sample.daysAgo * day - jitter;
      const decidedAt = submittedAt + (sample.decidedAfter ?? 0.5) * day;
      const paidAt = decidedAt + (sample.paidAfter ?? 1) * day;
      const iso = (ms: number) => new Date(Math.min(ms, now - 60_000)).toISOString();
      const decided = status !== "submitted";

      const request = await ctx.tables.requests.insert({
        title: sample.title,
        project: sample.project,
        category: sample.category,
        amountCents,
        status,
        requester: requester.id,
        approver: decided ? approver?.id : null,
        paidBy: status === "paid" ? payer?.id : null,
        decisionNote: decided ? (sample.decisionNote ?? null) : null,
        receipt: sample.receipt === undefined ? null : sampleFile(sample.receipt.file),
        submittedAt: iso(submittedAt),
        decidedAt: decided ? iso(decidedAt) : null,
        paidAt: status === "paid" ? iso(paidAt) : null
      });
      inserted++;

      const events: { kind: string; actor: string; note: string | null; at: number }[] = [
        { kind: "submitted", actor: requester.id, note: null, at: submittedAt }
      ];
      if (decided && approver !== undefined)
        events.push({
          kind: status === "rejected" ? "rejected" : "approved",
          actor: approver.id,
          note: sample.decisionNote ?? null,
          at: decidedAt
        });
      if (status === "paid" && payer !== undefined)
        events.push({ kind: "paid", actor: payer.id, note: null, at: paidAt });
      for (const note of sample.notes ?? []) {
        const actor = note.byRequester
          ? requester
          : (approver ?? people.find((person) => person.id !== requester.id));
        if (actor !== undefined)
          events.push({
            kind: "note",
            actor: actor.id,
            note: note.text,
            at: submittedAt + note.after * day
          });
      }
      await ctx.tables.events.insertMany(
        events.map((event) => ({
          request: request.id,
          kind: event.kind,
          actor: event.actor,
          note: event.note,
          at: iso(event.at)
        }))
      );
    }
    return { requests: inserted };
  }
});

/** Store the sample receipts, then insert the sample requests. Refuses unless the tool is empty. */
export const load = action({
  args: {},
  result: t.object({ requests: t.integer() }),
  errors: ["not_empty"],
  handler: async (ctx) => {
    const existing = await ctx.tables.requests.list({ limit: 1 });
    if (existing.rows.length > 0)
      throw new HandlerError("not_empty", { message: refusals.not_empty });
    const now = Date.now();
    for (const sample of samples) {
      if (sample.receipt === undefined) continue;
      // Quotes and receipts are dated a day or so before the request went in.
      const date = new Date(now - (sample.daysAgo + 1) * day);
      await ctx.files.receipts.put(
        sampleFile(sample.receipt.file),
        new TextEncoder().encode(receiptSvg(sample.receipt, sample.project, date)),
        {
          contentType: "image/svg+xml"
        }
      );
    }
    return ctx.run.samples.seed({});
  }
});
