import { query, mutation, action, t, HandlerError } from "../patchy/_generated/server.js";
import { requireOwner, canSee } from "../lib/rules.js";

const MAX_BYTES = 10 * 1024 * 1024;

const attachment = t.object({
  name: t.text(),
  size: t.number(),
  contentType: t.text(),
  updatedAt: t.text(),
  handle: t.fileHandle(),
  /** False when the bytes are stored but the attach step that records them did not finish. */
  recorded: t.boolean(),
  uploadedBy: t.nullable(t.text())
});

/** A file name safe as one path segment. */
const cleanName = (name: string) =>
  name
    .trim()
    .replaceAll("/", "_")
    .replace(/^\.{1,2}$/, "_");

/**
 * A deal's attachments for anyone who can see the deal: the files in the store under `<dealId>/`,
 * joined with their records. Subscribed, so it updates when anyone attaches or removes one.
 */
export const forDeal = query({
  args: t.object({ dealId: t.ref("deals") }),
  result: t.array(attachment),
  errors: ["not_found"],
  handler: async (ctx, { dealId }) => {
    const deal = await ctx.tables.deals.get(dealId);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    const [{ files }, records] = await Promise.all([
      ctx.files.attachments.list({ prefix: `${dealId}/`, limit: 1000 }),
      ctx.tables.dealFiles.list({ index: "deal", eq: { deal: dealId }, limit: 1000 })
    ]);
    const byName = new Map(records.rows.map((row) => [row.name, row]));
    return files.map((file) => {
      const name = file.name.slice(dealId.length + 1);
      const record = byName.get(name);
      return {
        name,
        size: file.size,
        contentType: file.contentType,
        updatedAt: file.updatedAt,
        handle: file.handle,
        recorded: record !== undefined,
        uploadedBy: record?.uploadedBy ?? null
      };
    });
  }
});

/** Records a stored file against its deal (idempotent). `attach` calls it; the page calls it to retry. */
export const record = mutation({
  args: t.object({ dealId: t.ref("deals"), name: t.text() }),
  result: t.row("dealFiles"),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { dealId, name }) => {
    const deal = await ctx.tables.deals.get(dealId);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    const existing = (
      await ctx.tables.dealFiles.list({ index: "deal", eq: { deal: dealId }, limit: 1000 })
    ).rows.find((row) => row.name === name);
    return (
      existing ??
      ctx.tables.dealFiles.insert({ deal: dealId, name, uploadedBy: ctx.viewer.user.id })
    );
  }
});

/** Drops a file's record (idempotent). `detach` calls it after deleting the bytes. */
export const unrecord = mutation({
  args: t.object({ dealId: t.ref("deals"), name: t.text() }),
  result: t.nullable(t.text()),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { dealId, name }) => {
    const deal = await ctx.tables.deals.get(dealId);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    const rows = (
      await ctx.tables.dealFiles.list({ index: "deal", eq: { deal: dealId }, limit: 1000 })
    ).rows;
    for (const row of rows) if (row.name === name) await ctx.tables.dealFiles.delete(row.id);
    return null;
  }
});

/**
 * Owner attaches a staged upload to a deal, in two steps: store the bytes, then record them.
 * A refusal before storing throws; after storing, the result says whether the record step landed.
 */
export const attach = action({
  args: t.object({ dealId: t.ref("deals"), name: t.text(), file: t.upload() }),
  result: t.object({ name: t.text(), stored: t.boolean(), recorded: t.boolean() }),
  errors: ["not_found", "not_owner", "too_large", "empty_file", "bad_name"],
  handler: async (ctx, { dealId, name, file }) => {
    const deal = await ctx.tables.deals.get(dealId);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    const clean = cleanName(name);
    if (clean === "" || new TextEncoder().encode(clean).length > 200)
      throw new HandlerError("bad_name");
    if (file.size === 0) throw new HandlerError("empty_file");
    if (file.size > MAX_BYTES) throw new HandlerError("too_large", { maxBytes: MAX_BYTES });
    await ctx.files.attachments.put(`${dealId}/${clean}`, file);
    try {
      await ctx.run.files!.record!({ dealId, name: clean });
      return { name: clean, stored: true, recorded: true };
    } catch (cause) {
      ctx.log("attachment stored but not recorded", { dealId, name: clean, cause: String(cause) });
      return { name: clean, stored: true, recorded: false };
    }
  }
});

/** Owner removes an attachment: delete the bytes, then the record; the result says how far it got. */
export const detach = action({
  args: t.object({ dealId: t.ref("deals"), name: t.text() }),
  result: t.object({ deleted: t.boolean(), unrecorded: t.boolean() }),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { dealId, name }) => {
    const deal = await ctx.tables.deals.get(dealId);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    await ctx.files.attachments.delete(`${dealId}/${name}`);
    try {
      await ctx.run.files!.unrecord!({ dealId, name });
      return { deleted: true, unrecorded: true };
    } catch (cause) {
      ctx.log("attachment deleted but its record remains", { dealId, name, cause: String(cause) });
      return { deleted: true, unrecorded: false };
    }
  }
});
