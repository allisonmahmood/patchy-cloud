import type { Row } from "patchy/config";
import type config from "../patchy.config.js";
import type { patchy } from "../patchy/_generated/client.js";

export type Kudos = Row<typeof config, "kudos">;
export type Reaction = Row<typeof config, "reactions">;
export type Member = NonNullable<Awaited<ReturnType<typeof patchy.members.get>>>;

/** Studio values a kudos can celebrate. `key` is stored in kudos.value; the rest is display. */
export const VALUES = [
  { key: "craft", label: "Craft", hint: "Beautifully made, sweated-the-details work" },
  { key: "client-love", label: "Client love", hint: "Made a client feel looked after" },
  { key: "teamwork", label: "Teamwork", hint: "Made the people around them better" },
  { key: "above-and-beyond", label: "Above & beyond", hint: "Did more than anyone asked" },
  { key: "fresh-thinking", label: "Fresh thinking", hint: "A new idea that moved things forward" }
] as const;

export type ValueKey = (typeof VALUES)[number]["key"];

export const valueLabel = (key: string): string =>
  VALUES.find((value) => value.key === key)?.label ?? key;

export const EMOJIS = ["👏", "🎉", "❤️", "🔥"] as const;
export type Emoji = (typeof EMOJIS)[number];

export const MESSAGE_MAX = 280;

/** What the wall is narrowed to. The side panel sets it; null means "everyone" / "every value". */
export type Filter = { readonly recipient: string | null; readonly value: string | null };

/** Resolved directory entries by id: undefined while loading, null when the id no longer resolves. */
export type People = ReadonlyMap<string, Member | null>;

export const firstName = (member: Member | null | undefined): string =>
  member ? (member.name.split(/\s+/)[0] ?? member.name) : "someone";
