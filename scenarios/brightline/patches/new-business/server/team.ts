// The company's member directory as the page sees it: owner pickers and CSV owner lookups.
import { query, t } from "../patchy/_generated/server.js";
import { personSchema, toPerson } from "../helpers/people.js";

/** Active members who can own deals. A non-empty search matches a prefix of name or email. */
export const people = query({
  args: { search: t.text(), cursor: t.nullable(t.text()) },
  result: t.object({ people: t.array(personSchema), cursor: t.nullable(t.text()) }),
  handler: async (ctx, args) => {
    const text = args.search.trim();
    const options = args.cursor === null ? {} : { cursor: args.cursor };
    const page =
      text === "" ? await ctx.members.list(options) : await ctx.members.search(text, options);
    return { people: page.rows.map(toPerson), cursor: page.cursor };
  }
});
