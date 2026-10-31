// The studio's member directory as the page sees it: names for the ids on the wall, and the
// colleague picker's search. Both are queries, so renames and departures show up live. A guest
// uses both too, so they return only what the page shows: no emails or admin flags.
import { query, t } from "../patchy/_generated/server.js";

const person = t.object({
  id: t.text(),
  name: t.text(),
  active: t.boolean(),
  guest: t.boolean()
});
type Person = {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly guest?: true;
};
const toPerson = ({ id, name, active, guest }: Person) => ({
  id,
  name,
  active,
  guest: guest === true
});

/** Each id's person, in order; null for an id the directory no longer knows. */
export const people = query({
  guest: true,
  args: { ids: t.array(t.text()) },
  result: t.array(t.nullable(person)),
  handler: async (ctx, args) =>
    args.ids.length === 0
      ? []
      : (await ctx.members.getMany(args.ids)).map((member) =>
          member === null ? null : toPerson(member)
        )
});

/** Active people whose name or email starts with the text; everyone for empty text. */
export const search = query({
  guest: true,
  args: { text: t.text() },
  result: t.array(person),
  handler: async (ctx, args) => {
    const page = args.text === "" ? await ctx.members.list() : await ctx.members.search(args.text);
    return page.rows.filter((member) => member.active).map(toPerson);
  }
});
