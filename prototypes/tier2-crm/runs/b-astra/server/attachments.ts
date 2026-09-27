import type config from "../patchy.config.js";
import type { Id } from "patchy/config";
import { action, query, t, HandlerError } from "../patchy/_generated/server.js";
import type { Context } from "../patchy/_generated/server.js";

const maxBytes = 20 * 1024 * 1024;
const fileEntry = t.object({
  name: t.text(),
  size: t.integer(),
  contentType: t.text(),
  updatedAt: t.timestamp(),
  handle: t.fileHandle()
});
type AccessContext = Pick<Context<typeof config, "query">, "viewer" | "tables">;

async function visibleDeal(ctx: AccessContext, dealId: Id<"deals">) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(dealId)) throw new HandlerError("not_found");
  const deal = await ctx.tables.deals.get(dealId);
  if (!deal || (deal.private && deal.ownerId !== ctx.viewer.user.id))
    throw new HandlerError("not_found");
  return deal;
}

async function ownedDeal(ctx: AccessContext, dealId: Id<"deals">) {
  const deal = await visibleDeal(ctx, dealId);
  if (deal.ownerId !== ctx.viewer.user.id) throw new HandlerError("not_owner");
}

function safeName(name: string) {
  const clean = name.normalize("NFC").trim();
  if (
    !clean ||
    clean === "." ||
    clean === ".." ||
    /[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)
  ) {
    throw new HandlerError("invalid_name");
  }
  const sanitized = clean.replace(/[<>:"|?*]/g, "_");
  if (new TextEncoder().encode(sanitized).byteLength > 255) throw new HandlerError("invalid_name");
  return sanitized;
}

function uploadKey(dealId: string, uploadId: string, name: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(uploadId)) throw new HandlerError("invalid_key");
  const key = `${dealId}/${uploadId}/${safeName(name)}`;
  if (new TextEncoder().encode(key).byteLength > 512) throw new HandlerError("invalid_key");
  return key;
}

function confinedKey(dealId: string, key: string) {
  const parts = key.split("/");
  if (
    parts.length !== 3 ||
    parts[0] !== dealId ||
    uploadKey(dealId, parts[1]!, parts[2]!) !== key
  ) {
    throw new HandlerError("invalid_key");
  }
  return key;
}

export const list = query({
  args: t.object({ dealId: t.ref("deals"), cursor: t.text().optional() }),
  result: t.object({ files: t.array(fileEntry), cursor: t.nullable(t.text()) }),
  errors: ["not_found"],
  handler: async (ctx, { dealId, cursor }) => {
    await visibleDeal(ctx, dealId);
    return ctx.files.attachments.list({
      prefix: `${dealId}/`,
      limit: 100,
      ...(cursor ? { cursor } : {})
    });
  }
});

export const stat = query({
  args: t.object({ dealId: t.ref("deals"), key: t.text() }),
  result: t.nullable(fileEntry),
  errors: ["not_found", "invalid_key", "invalid_name"],
  handler: async (ctx, { dealId, key }) => {
    await visibleDeal(ctx, dealId);
    return ctx.files.attachments.stat(confinedKey(dealId, key));
  }
});

export const upload = action({
  args: t.object({ dealId: t.ref("deals"), uploadId: t.text(), name: t.text(), file: t.upload() }),
  result: t.object({ key: t.text(), state: t.enum(["stored"]) }),
  errors: ["not_found", "not_owner", "invalid_key", "invalid_name", "too_large", "already_exists"],
  handler: async (ctx, { dealId, uploadId, name, file }) => {
    await ownedDeal(ctx, dealId);
    const key = uploadKey(dealId, uploadId, name);
    if (file.size > maxBytes) throw new HandlerError("too_large");
    if (await ctx.files.attachments.stat(key)) throw new HandlerError("already_exists");
    // Actions do not transact table reads with file writes. Check ownership again immediately before writing.
    await ownedDeal(ctx, dealId);
    await ctx.files.attachments.put(key, file);
    return { key, state: "stored" as const };
  }
});

export const remove = action({
  args: t.object({ dealId: t.ref("deals"), key: t.text() }),
  result: t.object({ key: t.text(), removed: t.boolean() }),
  errors: ["not_found", "not_owner", "invalid_key", "invalid_name"],
  handler: async (ctx, { dealId, key }) => {
    await ownedDeal(ctx, dealId);
    const safeKey = confinedKey(dealId, key);
    return { key: safeKey, removed: await ctx.files.attachments.delete(safeKey) };
  }
});
