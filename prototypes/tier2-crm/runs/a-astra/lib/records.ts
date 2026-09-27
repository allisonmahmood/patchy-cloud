import type config from "../patchy.config.js";
import type { Context } from "../patchy/_generated/server.js";
import { HandlerError } from "../patchy/_generated/server.js";
import type { Company, Deal } from "./models.js";

type ReadContext = Pick<Context<typeof config, "query">, "viewer" | "tables">;
export const stages = ["Lead", "Qualified", "Proposal", "Won", "Lost"] as const;
export function required(value: string, label: string) {
  const text = value.trim();
  if (!text || text.length > 300) throw new HandlerError("invalid_value", { field: label });
  return text;
}
export function owner(ctx: ReadContext, row: { ownerId: string }) {
  if (row.ownerId !== ctx.viewer.user.id) throw new HandlerError("owner_only");
}
export async function company(ctx: ReadContext, id: Company["id"]) {
  const row = await ctx.tables.companies.get(id);
  if (!row) throw new HandlerError("not_found");
  return row;
}
export async function deal(ctx: ReadContext, id: Deal["id"]) {
  const row = await ctx.tables.deals.get(id);
  if (!row || (row.private && row.ownerId !== ctx.viewer.user.id))
    throw new HandlerError("not_found");
  return row;
}
export async function teammate(ctx: ReadContext, userId: string) {
  const found = await ctx.tables.members.list({ index: "byUser", eq: { userId }, limit: 1 });
  if (!found.rows.length) throw new HandlerError("unknown_teammate");
}
export function emailAddress(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new HandlerError("invalid_email");
  return email;
}
