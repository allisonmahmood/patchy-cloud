// The deal desk reads Attio on the server, as the person viewing: owners, a page of open deals
// with their companies resolved in one getMany, and one deal with its pipeline entries.
import { action, t } from "../patchy/_generated/server.js";
import type { Records } from "../patchy/_generated/uses/crm.js";

const money = t.nullable(t.object({ amount: t.number(), currency: t.nullable(t.text()) }));
const toMoney = (value: Records["deals"]["values"]["value"] | undefined) =>
  value === null || value === undefined
    ? null
    : { amount: value.amount, currency: value.currency ?? null };

/** Active members who can own deals. */
export const owners = action({
  readOnly: true,
  args: {},
  result: t.array(t.object({ id: t.text(), name: t.text() })),
  handler: async (ctx) =>
    (await ctx.connections.crm.members.list())
      .filter((member) => member.active)
      .map(({ id, name }) => ({ id, name }))
});

/** One page of a stage's deals, largest first, each with its company's name. */
export const deals = action({
  readOnly: true,
  args: { stage: t.text(), owner: t.text(), cursor: t.nullable(t.text()) },
  result: t.object({
    deals: t.array(
      t.object({
        id: t.text(),
        name: t.nullable(t.text()),
        value: money,
        company: t.nullable(t.text())
      })
    ),
    cursor: t.nullable(t.text())
  }),
  handler: async (ctx, args) => {
    const crm = ctx.connections.crm;
    const page = await crm.objects.deals.list({
      eq: { stage: args.stage, ...(args.owner === "" ? {} : { owner: args.owner }) },
      orderBy: { attribute: "value", direction: "desc" },
      limit: 25,
      ...(args.cursor === null ? {} : { cursor: args.cursor })
    });
    const companies = await crm.objects.companies.getMany([
      ...new Set(page.rows.flatMap((deal) => deal.values.associated_company?.id ?? []))
    ]);
    const names = new Map(
      companies.flatMap((company) =>
        company === null ? [] : [[company.id, company.values.name ?? "Unnamed"] as const]
      )
    );
    return {
      deals: page.rows.map((deal) => ({
        id: deal.id,
        name: deal.values.name ?? null,
        value: toMoney(deal.values.value),
        company: names.get(deal.values.associated_company?.id ?? "") ?? null
      })),
      cursor: page.cursor ?? null
    };
  }
});

/** One deal, read afresh, and its entries in the sales pipeline, newest first; null once gone. */
export const deal = action({
  readOnly: true,
  args: { id: t.text() },
  result: t.nullable(
    t.object({
      name: t.nullable(t.text()),
      stage: t.nullable(t.text()),
      value: money,
      url: t.text(),
      entries: t.array(
        t.object({ id: t.text(), stage: t.nullable(t.text()), since: t.nullable(t.text()) })
      )
    })
  ),
  handler: async (ctx, args) => {
    const crm = ctx.connections.crm;
    const found = await crm.objects.deals.get(args.id);
    if (found === null) return null;
    const entries = await crm.lists.probe_pipeline.list({
      parent: args.id,
      orderBy: { attribute: "entered_on", direction: "desc" }
    });
    return {
      name: found.values.name ?? null,
      stage: found.values.stage ?? null,
      value: toMoney(found.values.value),
      url: found.url,
      entries: entries.rows.map((entry) => ({
        id: entry.id,
        stage: entry.values.stage ?? null,
        since: entry.values.entered_on ?? null
      }))
    };
  }
});
