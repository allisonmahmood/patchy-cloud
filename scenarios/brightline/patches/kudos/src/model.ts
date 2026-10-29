import type { Row } from "patchy/config";
import type config from "../patchy.config.js";
import type { patchy } from "../patchy/_generated/client.js";
import { VALUES } from "../helpers/kudos.js";

export { EMOJIS, MESSAGE_MAX, VALUES } from "../helpers/kudos.js";
export type { Emoji, ValueKey } from "../helpers/kudos.js";

export type Kudos = Row<typeof config, "kudos">;
export type Reaction = Row<typeof config, "reactions">;
export type Member = NonNullable<Awaited<ReturnType<typeof patchy.server.people.people>>[number]>;

export const valueLabel = (key: string): string =>
  VALUES.find((value) => value.key === key)?.label ?? key;

/** What the wall is narrowed to. The side panel sets it; null means "everyone" / "every value". */
export type Filter = { readonly recipient: string | null; readonly value: string | null };

/** Resolved directory entries by id: undefined while loading, null when the id no longer resolves. */
export type People = ReadonlyMap<string, Member | null>;

export const firstName = (member: Member | null | undefined): string =>
  member ? (member.name.split(/\s+/)[0] ?? member.name) : "someone";
