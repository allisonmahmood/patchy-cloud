// What is out of the kit room and who has it, and the two changes anyone at the studio makes:
// lending a piece of kit and marking it back.
import type { Id } from "patchy/config";
import { HandlerError, mutation, query, t } from "../patchy/_generated/server.js";

/** Everything still out, soonest due first, with who has it by name. */
export const out = query({
  args: {},
  result: t.array(
    t.object({
      id: t.text(),
      item: t.text(),
      borrower: t.text(),
      due: t.text(),
      overdue: t.boolean()
    })
  ),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.loans.list({ limit: 500 });
    const open = rows.filter((row) => !row.returned);
    const people =
      open.length === 0 ? [] : await ctx.members.getMany(open.map((row) => row.borrower));
    const names = new Map(
      people.flatMap((person) => (person === null ? [] : [[person.id, person.name] as const]))
    );
    const today = new Date().toISOString().slice(0, 10);
    return open
      .map((row) => {
        const due = new Date(row.due ?? "").toISOString().slice(0, 10);
        return {
          id: row.id,
          item: row.item,
          borrower: names.get(row.borrower) ?? "Someone who left",
          due,
          overdue: due < today
        };
      })
      .sort((a, b) => a.due.localeCompare(b.due));
  }
});

/** Active colleagues, to choose who has the kit. */
export const people = query({
  args: {},
  result: t.array(t.object({ id: t.text(), name: t.text() })),
  handler: async (ctx) =>
    (await ctx.members.list()).rows
      .filter((member) => member.active)
      .map(({ id, name }) => ({ id, name }))
});

/** Lends a piece of kit to a colleague, until a day or open-ended. */
export const lend = mutation({
  args: { item: t.text(), borrower: t.text(), due: t.nullable(t.text()) },
  errors: ["no_item", "not_a_colleague"],
  result: t.row("loans"),
  handler: async (ctx, args) => {
    const item = args.item.trim();
    if (item === "") throw new HandlerError("no_item", {});
    const borrower = await ctx.members.get(args.borrower);
    if (borrower === null || !borrower.active) throw new HandlerError("not_a_colleague", {});
    return ctx.tables.loans.insert({
      item,
      borrower: borrower.id,
      due: args.due === null ? null : new Date(args.due).toISOString(),
      returned: false
    });
  }
});

/** Marks a loan as back in the kit room. */
export const back = mutation({
  args: { id: t.text() },
  errors: ["no_loan"],
  result: t.row("loans"),
  handler: async (ctx, args) => {
    const loan = await ctx.tables.loans.get(args.id as Id<"loans">);
    if (loan === null) throw new HandlerError("no_loan", {});
    return ctx.tables.loans.update(loan.id, { returned: true });
  }
});
