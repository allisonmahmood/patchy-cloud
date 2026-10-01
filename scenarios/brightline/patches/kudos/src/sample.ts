import { patchy } from "../patchy/_generated/client.js";
import type { Emoji, Member, ValueKey } from "./model.js";

type SampleKudos = {
  /** Person slots 0-4, mapped onto whoever is in the directory (wrapping when fewer). */
  readonly to: number;
  readonly from: number;
  readonly value: ValueKey;
  /** Minutes before now for today's kudos, otherwise days ago at a working-hours time. */
  readonly when:
    | { readonly minutesAgo: number }
    | { readonly daysAgo: number; readonly at: readonly [number, number] };
  readonly message: string;
  readonly reactions: Partial<Record<Emoji, number>>;
};

const SAMPLE: readonly SampleKudos[] = [
  {
    to: 2,
    from: 0,
    value: "craft",
    when: { minutesAgo: 42 },
    message:
      "The Harbor & Pine Coffee packaging comps were stunning. The way the label system flexes across all six blends is exactly the kind of detail clients remember.",
    reactions: { "👏": 3, "🔥": 2 }
  },
  {
    to: 1,
    from: 3,
    value: "client-love",
    when: { minutesAgo: 190 },
    message:
      "Stayed late on the Kestrel Health call to walk their compliance team through the patient portal flows, screen by screen. They left the call genuinely relieved.",
    reactions: { "❤️": 2, "👏": 1 }
  },
  {
    to: 3,
    from: 2,
    value: "teamwork",
    when: { daysAgo: 1, at: [16, 20] },
    message:
      "Jumped in to finish the Northline Bikes launch assets when we were two people down. Calm, quick and somehow still funny at 7pm.",
    reactions: { "🎉": 2, "❤️": 1 }
  },
  {
    to: 2,
    from: 4,
    value: "fresh-thinking",
    when: { daysAgo: 2, at: [11, 5] },
    message:
      "Turning the Atlas Outdoor Co. product finder into a trail quiz was a brilliant call. Their team loved it and it's already in the next sprint.",
    reactions: { "🔥": 3, "👏": 1 }
  },
  {
    to: 0,
    from: 1,
    value: "above-and-beyond",
    when: { daysAgo: 3, at: [9, 40] },
    message:
      "Rebuilt the Mosaic Credit Union pitch deck overnight after the brief changed, then walked into the meeting like it was nothing. We won the room.",
    reactions: { "🎉": 3, "👏": 2, "🔥": 1 }
  },
  {
    to: 4,
    from: 2,
    value: "craft",
    when: { daysAgo: 5, at: [14, 15] },
    message:
      "The Fieldnote Press type specimen is gorgeous. Every spread feels considered, right down to the folios.",
    reactions: { "👏": 2 }
  },
  {
    to: 1,
    from: 0,
    value: "client-love",
    when: { daysAgo: 6, at: [17, 30] },
    message:
      "Saltwater Hotels told us our account handling is the best they've had from any agency. That's your weekly check-ins paying off.",
    reactions: { "❤️": 3, "🎉": 1 }
  },
  {
    to: 2,
    from: 1,
    value: "teamwork",
    when: { daysAgo: 8, at: [10, 50] },
    message:
      "Thanks for pairing with our new starters on the Lumen Labs design system. They're already shipping components on their own.",
    reactions: { "👏": 2, "❤️": 1 }
  },
  {
    to: 3,
    from: 4,
    value: "fresh-thinking",
    when: { daysAgo: 11, at: [15, 0] },
    message:
      "Suggested we reuse the Verdant Grocers shoot footage for the seasonal cut-downs and saved the client a full production day.",
    reactions: { "🔥": 2 }
  },
  {
    to: 2,
    from: 3,
    value: "above-and-beyond",
    when: { daysAgo: 13, at: [12, 10] },
    message:
      "Caught the accessibility issues on the Parkside Dental Group booking flow before launch and fixed them over the weekend. Huge.",
    reactions: { "👏": 3, "❤️": 2 }
  },
  {
    to: 0,
    from: 2,
    value: "craft",
    when: { daysAgo: 17, at: [16, 45] },
    message:
      "The motion pass on the Northline Bikes homepage is so smooth. Subtle, quick, and it makes the whole site feel premium.",
    reactions: { "🔥": 2, "👏": 1 }
  },
  {
    to: 3,
    from: 1,
    value: "teamwork",
    when: { daysAgo: 21, at: [11, 30] },
    message:
      "Ran a brilliant retro after the Kestrel Health sprint. Everyone left with clear actions and nobody felt blamed.",
    reactions: { "👏": 1 }
  },
  {
    to: 4,
    from: 0,
    value: "client-love",
    when: { daysAgo: 26, at: [9, 15] },
    message:
      "Turned a tense feedback round with Atlas Outdoor Co. into a genuinely productive workshop. A masterclass in listening.",
    reactions: { "❤️": 2, "🎉": 1 }
  },
  {
    to: 1,
    from: 2,
    value: "craft",
    when: { daysAgo: 34, at: [14, 40] },
    message:
      "Your art direction on the Saltwater Hotels shoot raised the bar for all of us. Those dusk shots are unreal.",
    reactions: { "🔥": 3, "👏": 2 }
  }
];

/** A refusal the person can act on, shown verbatim. */
export class SampleRefused extends Error {}

function sentAt(when: SampleKudos["when"], now: number): string {
  if ("minutesAgo" in when) return new Date(now - when.minutesAgo * 60_000).toISOString();
  const date = new Date(now);
  date.setDate(date.getDate() - when.daysAgo);
  date.setHours(when.at[0], when.at[1], 0, 0);
  return date.toISOString();
}

/**
 * Fills an empty wall with realistic kudos between the company's current members, plus reactions
 * from people other than the sender. Refuses when the wall already has kudos. Tier 1 writes are
 * advisory, so this check lives in the page; it guards against accidents, not determined users.
 */
export async function loadSampleData(): Promise<number> {
  const existing = await patchy.tables.kudos.list({ limit: 1 });
  if (existing.rows.length > 0)
    throw new SampleRefused("The wall already has kudos, so sample data wasn't added.");

  const people: readonly Member[] = (await patchy.members.list()).rows.filter(
    (member) => member.active
  );
  if (people.length < 2)
    throw new SampleRefused("Sample kudos need at least two people in your company.");

  const slot = (index: number) => index % people.length;
  const now = Date.now();
  const kudos = await patchy.tables.kudos.insertMany(
    SAMPLE.map((sample) => {
      const to = slot(sample.to);
      const from = slot(sample.from) === to ? (to + 1) % people.length : slot(sample.from);
      return {
        recipient: people[to]!.id,
        sender: people[from]!.id,
        value: sample.value,
        message: sample.message,
        sentAt: sentAt(sample.when, now)
      };
    })
  );

  const reactions = kudos.flatMap((row, index) => {
    const others = people.filter((member) => member.id !== row.sender);
    return Object.entries(SAMPLE[index]!.reactions).flatMap(([emoji, count], offset) =>
      Array.from({ length: Math.min(count, others.length) }, (_, nth) => ({
        kudos: row.id,
        member: others[(nth + offset + index) % others.length]!.id,
        emoji
      }))
    );
  });
  if (reactions.length > 0) await patchy.tables.reactions.insertMany(reactions);
  return kudos.length;
}
