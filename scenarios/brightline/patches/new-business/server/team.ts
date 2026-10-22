// The company's member directory as the page sees it: owner pickers and CSV owner lookups.
// agent/deals.ts gives people's agents `people` as findPeople.
import { query, t } from "../patchy/_generated/server.js";
import { personSchema, toPerson } from "../helpers/people.js";

/** Active members who can own deals. A non-empty search matches a prefix of name or email. */
export const people = query({
  description:
    "Finds the studio's active members, who can own deals: an empty search lists everyone, page by page, and " +
    "any other matches the start of a name or email. Pass the answer's cursor back for the next page.",
  args: {
    search: t.text().describe("The start of a name or email, or empty for everyone."),
    cursor: t.nullable(t.text()).describe("The cursor from the previous page, or null.")
  },
  result: t.object({ people: t.array(personSchema), cursor: t.nullable(t.text()) }),
  handler: async (ctx, args) => {
    const text = args.search.trim();
    const options = args.cursor === null ? {} : { cursor: args.cursor };
    const page =
      text === "" ? await ctx.members.list(options) : await ctx.members.search(text, options);
    return { people: page.rows.map(toPerson), cursor: page.cursor };
  }
});
