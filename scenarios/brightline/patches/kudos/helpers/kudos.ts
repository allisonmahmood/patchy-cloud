// What a kudos can say, shared by the page and the server: plain constants, safe in either.

/** The keys kudos.value stores, one per studio value below. */
export const VALUE_KEYS = [
  "craft",
  "client-love",
  "teamwork",
  "above-and-beyond",
  "fresh-thinking"
] as const;
export type ValueKey = (typeof VALUE_KEYS)[number];

/** Studio values a kudos can celebrate. `key` is stored in kudos.value; the rest is display. */
export const VALUES: ReadonlyArray<{
  readonly key: ValueKey;
  readonly label: string;
  readonly hint: string;
}> = [
  { key: "craft", label: "Craft", hint: "Beautifully made, sweated-the-details work" },
  { key: "client-love", label: "Client love", hint: "Made a client feel looked after" },
  { key: "teamwork", label: "Teamwork", hint: "Made the people around them better" },
  { key: "above-and-beyond", label: "Above & beyond", hint: "Did more than anyone asked" },
  { key: "fresh-thinking", label: "Fresh thinking", hint: "A new idea that moved things forward" }
];

export const EMOJIS = ["👏", "🎉", "❤️", "🔥"] as const;
export type Emoji = (typeof EMOJIS)[number];

export const MESSAGE_MAX = 280;
