import { action, query, t, HandlerError } from "../patchy/_generated/server.js";
import { deal, owner } from "../lib/records.js";

const fileShape = t.object({
  name: t.text(),
  size: t.number(),
  contentType: t.text(),
  handle: t.fileHandle()
});
const errors = ["not_found", "owner_only", "invalid_filename", "too_large"] as const;
const outcome = t.object({ state: t.enum(["stored", "absent", "unknown"]), message: t.text() });
function path(dealId: string, token: string, name: string) {
  if (
    !/^[a-zA-Z0-9-]{16,80}$/.test(token) ||
    !name.trim() ||
    /[\\/\u0000-\u001f]/.test(name) ||
    name === "." ||
    name === ".." ||
    new TextEncoder().encode(name).length > 180
  )
    throw new HandlerError("invalid_filename");
  return `${dealId}/${token}/${name}`;
}
export const list = query({
  args: t.object({ dealId: t.ref("deals"), cursor: t.text().optional() }),
  result: t.object({ files: t.array(fileShape), cursor: t.nullable(t.text()) }),
  errors,
  handler: async (ctx, { dealId, cursor }) => {
    await deal(ctx, dealId);
    const page = await ctx.files.attachments.list({
      prefix: `${dealId}/`,
      limit: 50,
      ...(cursor ? { cursor } : {})
    });
    return {
      files: page.files.map(({ name, size, contentType, handle }) => ({
        name,
        size,
        contentType,
        handle
      })),
      cursor: page.cursor
    };
  }
});
export const status = query({
  args: t.object({ dealId: t.ref("deals"), token: t.text(), name: t.text() }),
  result: outcome,
  errors,
  handler: async (ctx, args) => {
    await deal(ctx, args.dealId);
    const stored = await ctx.files.attachments.stat(path(args.dealId, args.token, args.name));
    return {
      state: stored ? ("stored" as const) : ("absent" as const),
      message: stored
        ? "The file is saved and attached to this deal."
        : "No attachment exists for this upload. You can choose the file again."
    };
  }
});
export const attach = action({
  args: t.object({ dealId: t.ref("deals"), token: t.text(), name: t.text(), file: t.upload() }),
  result: outcome,
  errors,
  handler: async (ctx, args) => {
    owner(ctx, await deal(ctx, args.dealId));
    const key = path(args.dealId, args.token, args.name);
    if (args.file.size > 20 * 1024 * 1024) throw new HandlerError("too_large");
    // The file store is the attachment record: there is no second metadata write to fail.
    try {
      await ctx.files.attachments.put(key, args.file);
      return { state: "stored" as const, message: "The file is saved and attached to this deal." };
    } catch {
      try {
        const stored = await ctx.files.attachments.stat(key);
        return {
          state: stored ? ("stored" as const) : ("absent" as const),
          message: stored
            ? "The write reported an error, but verification confirms the attachment is saved."
            : "The attachment was not saved. The staged upload may have been consumed; choose the file again."
        };
      } catch {
        return {
          state: "unknown" as const,
          message:
            "The upload outcome could not be verified. Check this upload's status before retrying; no write was replayed."
        };
      }
    }
  }
});
export const remove = action({
  args: t.object({ dealId: t.ref("deals"), name: t.text() }),
  result: outcome,
  errors,
  handler: async (ctx, { dealId, name }) => {
    owner(ctx, await deal(ctx, dealId));
    if (!name.startsWith(`${dealId}/`)) throw new HandlerError("not_found");
    try {
      await ctx.files.attachments.delete(name);
      return { state: "absent" as const, message: "The attachment was removed." };
    } catch {
      try {
        const stored = await ctx.files.attachments.stat(name);
        return {
          state: stored ? ("stored" as const) : ("absent" as const),
          message: stored
            ? "Removal failed. The attachment is still saved."
            : "The attachment was removed, despite a lost reply."
        };
      } catch {
        return {
          state: "unknown" as const,
          message: "Removal could not be verified. Check the live attachment list before retrying."
        };
      }
    }
  }
});
