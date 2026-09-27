// PROTOTYPE for #315: the contracts source the boundary proofs read through a shared store.
import { query, action, t, HandlerError } from "../patchy/_generated/server";

const entry = t.object({
  name: t.text(),
  size: t.number(),
  contentType: t.text(),
  updatedAt: t.text(),
  handle: t.fileHandle()
});

export const list = query({
  args: t.object({}),
  result: t.array(entry),
  handler: async (ctx) => (await ctx.files.documents.list({ limit: 100 })).files
});

/** Replaces (or adds) one document from a staged upload: the source's own path. */
export const replace = action({
  args: t.object({ name: t.text(), file: t.upload() }),
  result: entry,
  errors: ["too_large", "not_a_document"],
  handler: async (ctx, { name, file }) => {
    if (file.size > 5_000_000) throw new HandlerError("too_large");
    if (!["application/pdf", "image/png"].includes(file.contentType))
      throw new HandlerError("not_a_document");
    return ctx.files.documents.put(name, file);
  }
});
