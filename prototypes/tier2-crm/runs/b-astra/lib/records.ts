import { HandlerError } from "patchy/server";
import type { Context } from "patchy/server";
import type { Id } from "patchy/config";
import type config from "../patchy.config.js";

type Tables = Context<typeof config, "query">["tables"];
export const stages = ["Lead", "Qualified", "Proposal", "Won", "Lost"] as const;
export function required(value: string, field: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) throw new HandlerError("invalid_input", { field });
  return trimmed;
}
export function owner(record: { ownerId: string } | null, userId: string) {
  if (!record) throw new HandlerError("not_found");
  if (record.ownerId !== userId) throw new HandlerError("not_owner");
}
export async function visibleDeal(tables: Tables, id: Id<"deals">, userId: string) {
  const deal = await tables.deals.get(id);
  if (!deal || (deal.private && deal.ownerId !== userId)) throw new HandlerError("not_found");
  return deal;
}
export async function targetOwner(tables: Tables, userId: string) {
  const page = await tables.members.list({ index: "byUser", eq: { userId }, limit: 1 });
  if (!page.rows[0]) throw new HandlerError("unknown_teammate");
  return userId;
}
export async function companyExists(tables: Tables, id: Id<"companies">) {
  if (!(await tables.companies.get(id))) throw new HandlerError("company_not_found");
}
export function emailAddress(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new HandlerError("invalid_email");
  return email;
}
