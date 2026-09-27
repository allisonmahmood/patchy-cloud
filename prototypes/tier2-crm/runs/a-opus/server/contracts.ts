import { query, t } from "../patchy/_generated/server.js";

const file = t.object({
  name: t.text(),
  size: t.number(),
  updatedAt: t.text(),
  handle: t.fileHandle()
});

/** The contracts tool names files by slug: lower case with hyphens, e.g. "Acme Robotics" → acme-robotics. */
const slugOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * A company's signed contract PDF and first-page thumbnail from the contracts tool's shared store.
 * Subscribed, it re-runs whenever the contracts tool writes or stops sharing the store.
 */
export const forCompany = query({
  args: t.object({ name: t.text() }),
  result: t.object({ pdf: t.nullable(file), thumbnail: t.nullable(file) }),
  handler: async (ctx, { name }) => {
    const slug = slugOf(name);
    const [pdf, thumbnail] = await Promise.all([
      ctx.shared.contracts.stat(`${slug}.pdf`),
      ctx.shared.contracts.stat(`${slug}.png`)
    ]);
    const pick = (entry: typeof pdf) =>
      entry && {
        name: entry.name,
        size: entry.size,
        updatedAt: entry.updatedAt,
        handle: entry.handle
      };
    return { pdf: pick(pdf), thumbnail: pick(thumbnail) };
  }
});
