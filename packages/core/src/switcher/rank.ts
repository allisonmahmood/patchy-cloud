/**
 * How the switcher filters and orders what it lists once something is typed. Every typed word
 * must match the start of a word in the title or the name, in any order, so "hq sales" finds
 * Sales HQ. Failing that, the typed letters may be the start of the words' initials: "sh" finds
 * Sales HQ. From three letters a word may also match inside one, ranked lowest. There is no
 * typo tolerance.
 *
 * Matches sort by that tier, then by how much the viewer opens them, then by title, then by id,
 * so one list and one query always give one order.
 */

/** Something the switcher can list. */
export interface Rankable {
  readonly id: string;
  readonly title: string;
  /** A second name it answers to, such as a patch's address name. */
  readonly name?: string | undefined;
  /** How much the viewer uses it, higher first: Home's open score. */
  readonly score?: number | undefined;
}

/** How a query matched, best first. */
export type Tier = "word" | "initials" | "inside";
const order: Readonly<Record<Tier, number>> = { word: 0, initials: 1, inside: 2 };

/** Case and accents folded, so "é" is typed as "e". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Runs of letters and digits, also split where a lower case letter meets an upper case one. */
const words = (text: string) =>
  fold(text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

/** The tier `query` matches `item` at, or undefined when it doesn't. */
export const matchTier = (query: string, item: Rankable): Tier | undefined => {
  const typed = words(query);
  if (typed.length === 0) return undefined;
  const fields = [words(item.title), ...(item.name === undefined ? [] : [words(item.name)])];
  const all = fields.flat();
  let inside = false;
  const each = typed.every((word) => {
    if (all.some((candidate) => candidate.startsWith(word))) return true;
    inside = word.length >= 3 && all.some((candidate) => candidate.includes(word));
    return inside;
  });
  if (each && !inside) return "word";
  const letters = typed.join("");
  const initials = fields.some(
    (field) =>
      field.length > 1 &&
      field
        .map((word) => Array.from(word)[0])
        .join("")
        .startsWith(letters)
  );
  if (letters.length > 1 && initials) return "initials";
  return each ? "inside" : undefined;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The items `query` matches, best first. */
export const rank = <Item extends Rankable>(query: string, items: ReadonlyArray<Item>): Item[] =>
  items
    .flatMap((item) => {
      const tier = matchTier(query, item);
      return tier === undefined ? [] : [{ item, tier: order[tier], title: fold(item.title) }];
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (b.item.score ?? 0) - (a.item.score ?? 0) ||
        compare(a.title, b.title) ||
        compare(a.item.title, b.item.title) ||
        compare(a.item.id, b.item.id)
    )
    .map(({ item }) => item);
