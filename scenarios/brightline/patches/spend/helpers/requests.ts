// Server-only: writing a submitted request, shared by the page's create in server/ and the
// agents' submitRequest in agent/, so both record it the same way.
import type { Id } from "patchy/config";
import type { MutationContext } from "../patchy/_generated/server.js";
import type { Category } from "./spend.js";

export interface RequestFields {
  readonly title: string;
  readonly project: string;
  readonly category: Category;
  readonly amountCents: number;
}

/**
 * Inserts a checked request as submitted by the viewer, claims its receipt and writes the
 * "submitted" event, in the caller's transaction.
 */
export async function insertSubmitted(
  ctx: MutationContext,
  fields: RequestFields,
  claim: { readonly id: Id<"receiptFiles">; readonly name: string } | null
) {
  const me = ctx.viewer.user.id;
  const now = new Date().toISOString();
  const request = await ctx.tables.requests.insert({
    title: fields.title.trim(),
    project: fields.project.trim(),
    category: fields.category,
    amountCents: fields.amountCents,
    status: "submitted",
    requester: me,
    receipt: claim?.name ?? null,
    submittedAt: now
  });
  if (claim !== null) await ctx.tables.receiptFiles.update(claim.id, { request: request.id });
  await ctx.tables.events.insert({ request: request.id, kind: "submitted", actor: me, at: now });
  return request;
}
