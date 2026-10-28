// The review reads Attio on the server: every deal in a stage, page by page, totalled by owner,
// with the largest deals' companies resolved in one getMany. Nothing is written anywhere.
import { action, t } from "../patchy/_generated/server.js";

/** One stage's deals, summed by owner, and the five largest with their companies. */
export const summary = action({
  readOnly: true,
  args: { stage: t.text() },
  result: t.object({
    stage: t.text(),
    deals: t.integer(),
    value: t.number(),
    owners: t.array(t.object({ name: t.text(), deals: t.integer(), value: t.number() })),
    top: t.array(
      t.object({
        name: t.nullable(t.text()),
        value: t.nullable(t.number()),
        company: t.nullable(t.text())
      })
    )
  }),
  handler: async (ctx, { stage }) => {
    const crm = ctx.connections.crm;
    const deals = [];
    let cursor: string | undefined;
    do {
      const page = await crm.objects.deals.list({
        eq: { stage },
        orderBy: { attribute: "value", direction: "desc" },
        limit: 500,
        ...(cursor === undefined ? {} : { cursor })
      });
      deals.push(...page.rows);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    const members = new Map((await crm.members.list()).map((member) => [member.id, member.name]));
    const byOwner = new Map<string, { deals: number; value: number }>();
    for (const deal of deals) {
      const owner = deal.values.owner?.id ?? "";
      const total = byOwner.get(owner) ?? { deals: 0, value: 0 };
      total.deals += 1;
      total.value += deal.values.value?.amount ?? 0;
      byOwner.set(owner, total);
    }
    const top = deals.slice(0, 5);
    const companies = await crm.objects.companies.getMany(
      top.flatMap((deal) => deal.values.associated_company?.id ?? [])
    );
    const names = new Map(
      companies.flatMap((company) => (company === null ? [] : [[company.id, company.values.name]]))
    );
    return {
      stage,
      deals: deals.length,
      value: deals.reduce((sum, deal) => sum + (deal.values.value?.amount ?? 0), 0),
      owners: [...byOwner]
        .map(([id, total]) => ({ name: members.get(id) ?? "No owner", ...total }))
        .sort((a, b) => b.value - a.value),
      top: top.map((deal) => ({
        name: deal.values.name,
        value: deal.values.value?.amount ?? null,
        company: names.get(deal.values.associated_company?.id ?? "") ?? null
      }))
    };
  }
});
