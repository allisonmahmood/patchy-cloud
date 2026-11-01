// A few loans to the studio's own people, for a first look; refused once anything is logged.
import { HandlerError, mutation, t } from "../patchy/_generated/server.js";

const DAY = 24 * 60 * 60 * 1000;

export const load = mutation({
  args: {},
  errors: ["not_empty"],
  result: t.integer(),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.loans.list({ limit: 1 });
    if (rows.length > 0) throw new HandlerError("not_empty", {});
    const people = (await ctx.members.list()).rows.filter((member) => member.active);
    const who = (index: number) => people[index % people.length]!.id;
    const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();
    const samples = [
      { item: "Sony FX3 camera body", borrower: who(1), due: inDays(3) },
      { item: "Rode Wireless GO II mic kit", borrower: who(2), due: inDays(-1) },
      { item: "Manfrotto tripod", borrower: who(0), due: null },
      { item: "Loaner MacBook Pro 14", borrower: who(1), due: inDays(10) }
    ];
    for (const sample of samples) await ctx.tables.loans.insert({ ...sample, returned: false });
    return samples.length;
  }
});
