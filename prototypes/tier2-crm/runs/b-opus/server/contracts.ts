import { query, t, HandlerError } from "../patchy/_generated/server.js";
import { companySlug } from "../shared/rules.js";

const file = t.object({ name: t.text(), size: t.number(), handle: t.fileHandle() });

/**
 * A company's contract from the contracts tool's shared store: `<slug>.pdf` and its first-page
 * thumbnail `<slug>.png`, either of which may be missing. Subscribed, it re-runs whenever the
 * contracts tool writes its store or changes its sharing.
 */
export const forCompany = query({
  args: t.object({ companyId: t.ref("companies") }),
  result: t.object({ slug: t.text(), pdf: t.nullable(file), thumbnail: t.nullable(file) }),
  errors: ["not_found"],
  handler: async (ctx, { companyId }) => {
    const company = await ctx.tables.companies.get(companyId);
    if (company === null) throw new HandlerError("not_found");
    const slug = companySlug(company.name);
    const [pdf, thumbnail] = await Promise.all([
      ctx.shared.contracts.stat(`${slug}.pdf`),
      ctx.shared.contracts.stat(`${slug}.png`)
    ]);
    const pick = (entry: typeof pdf) =>
      entry ? { name: entry.name, size: entry.size, handle: entry.handle } : null;
    return { slug, pdf: pick(pdf), thumbnail: pick(thumbnail) };
  }
});
