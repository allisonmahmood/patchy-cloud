import { query, action, t, HandlerError } from "../patchy/_generated/server.js";
import type { Context } from "patchy/server";
import type { Id } from "patchy/config";
import type config from "../patchy.config.js";
import { assertOwner, visibleDeal } from "../shared/access.js";

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;

/**
 * A deal's attachments as stored. `recorded` is false for a file whose record was never written
 * (an attach that stopped partway); `stored` is false for a record whose file is gone.
 */
const attachment = t.object({
  key: t.text(),
  name: t.text(),
  size: t.number(),
  contentType: t.text(),
  uploadedBy: t.nullable(t.text()),
  handle: t.nullable(t.fileHandle()),
  stored: t.boolean(),
  recorded: t.boolean()
});

/** Anyone who can see the deal sees its attachments; a private deal's are its owner's alone. */
export const list = query({
  args: t.object({ dealId: t.ref("deals") }),
  result: t.array(attachment),
  errors: ["not_found"],
  handler: async (ctx, { dealId }) => {
    await visibleDeal(ctx.tables, ctx.viewer, dealId);
    const [{ files }, { rows }] = await Promise.all([
      ctx.files.dealFiles.list({ prefix: `${dealId}/`, limit: 1000 }),
      ctx.tables.attachments.list({ index: "dealId", eq: { dealId }, limit: 1000 })
    ]);
    const records = new Map(rows.map((row) => [row.key, row]));
    const stored = files.map((file) => {
      const record = records.get(file.name);
      records.delete(file.name);
      return {
        key: file.name,
        name: record?.name ?? file.name.slice(dealId.length + 1),
        size: file.size,
        contentType: file.contentType,
        uploadedBy: record?.uploadedBy ?? null,
        handle: file.handle,
        stored: true,
        recorded: record !== undefined
      };
    });
    const orphans = [...records.values()].map((row) => ({
      key: row.key,
      name: row.name,
      size: row.size,
      contentType: row.contentType,
      uploadedBy: row.uploadedBy,
      handle: null,
      stored: false,
      recorded: true
    }));
    return [...stored, ...orphans];
  }
});

/** Writes or refreshes the record for a stored file. Returns an error message instead of throwing. */
async function record(
  ctx: Pick<Context<typeof config, "action">, "tables" | "viewer" | "log">,
  entry: { dealId: Id<"deals">; key: string; name: string; contentType: string; size: number }
): Promise<string | null> {
  try {
    const { rows } = await ctx.tables.attachments.list({
      index: "byKey",
      eq: { key: entry.key },
      limit: 1
    });
    const fields = {
      name: entry.name,
      contentType: entry.contentType,
      size: entry.size,
      uploadedBy: ctx.viewer.user.name
    };
    if (rows[0]) await ctx.tables.attachments.update(rows[0].id, fields);
    else await ctx.tables.attachments.insert({ ...fields, dealId: entry.dealId, key: entry.key });
    return null;
  } catch (error) {
    ctx.log("attachment record failed", { key: entry.key, error: String(error) });
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Attaches a staged upload to a deal in two steps: store the bytes, then record them. The steps
 * are not atomic, so the result reports each: `stored` true with `recorded` false means the file
 * is saved but not yet listed as recorded, and `recordAgain` can finish it.
 */
export const attach = action({
  args: t.object({ dealId: t.ref("deals"), name: t.text(), file: t.upload() }),
  result: t.object({
    stored: t.boolean(),
    recorded: t.boolean(),
    key: t.text(),
    problem: t.nullable(t.text())
  }),
  errors: ["not_found", "not_owner", "too_large", "unsupported_type", "empty_name"],
  handler: async (ctx, { dealId, name, file }) => {
    assertOwner(await visibleDeal(ctx.tables, ctx.viewer, dealId), ctx.viewer);
    const clean = name
      .replace(/[\\/]+/g, "-")
      .replace(/^\.+/, "")
      .trim();
    if (clean === "") throw new HandlerError("empty_name");
    if (file.size > MAX_BYTES) throw new HandlerError("too_large", { max: MAX_BYTES });
    if (!ALLOWED.test(file.contentType))
      throw new HandlerError("unsupported_type", { contentType: file.contentType });
    const key = `${dealId}/${clean}`;
    const entry = await ctx.files.dealFiles.put(key, file);
    const problem = await record(ctx, {
      dealId,
      key,
      name: clean,
      contentType: entry.contentType,
      size: entry.size
    });
    return { stored: true, recorded: problem === null, key, problem };
  }
});

/** Finishes an attach that stored its file but failed to record it. */
export const recordAgain = action({
  args: t.object({ dealId: t.ref("deals"), key: t.text() }),
  result: t.object({ recorded: t.boolean(), problem: t.nullable(t.text()) }),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { dealId, key }) => {
    assertOwner(await visibleDeal(ctx.tables, ctx.viewer, dealId), ctx.viewer);
    if (!key.startsWith(`${dealId}/`)) throw new HandlerError("not_found");
    const entry = await ctx.files.dealFiles.stat(key);
    if (entry === null) throw new HandlerError("not_found");
    const problem = await record(ctx, {
      dealId,
      key,
      name: key.slice(dealId.length + 1),
      contentType: entry.contentType,
      size: entry.size
    });
    return { recorded: problem === null, problem };
  }
});

/** Removes the file, then its record; the result says which of the two happened. */
export const remove = action({
  args: t.object({ dealId: t.ref("deals"), key: t.text() }),
  result: t.object({
    fileRemoved: t.boolean(),
    recordRemoved: t.boolean(),
    problem: t.nullable(t.text())
  }),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { dealId, key }) => {
    assertOwner(await visibleDeal(ctx.tables, ctx.viewer, dealId), ctx.viewer);
    if (!key.startsWith(`${dealId}/`)) throw new HandlerError("not_found");
    await ctx.files.dealFiles.delete(key);
    try {
      const { rows } = await ctx.tables.attachments.list({ index: "byKey", eq: { key }, limit: 1 });
      if (rows[0]) await ctx.tables.attachments.delete(rows[0].id);
      return { fileRemoved: true, recordRemoved: true, problem: null };
    } catch (error) {
      return {
        fileRemoved: true,
        recordRemoved: false,
        problem: error instanceof Error ? error.message : String(error)
      };
    }
  }
});
