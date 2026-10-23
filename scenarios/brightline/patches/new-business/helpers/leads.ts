// Server-only: adding leads and choosing owners, shared by the page's handlers in server/ and
// the agents' tools in agent/, so both keep the same rules.
import { HandlerError, type MutationContext } from "../patchy/_generated/server.js";
import { checkDeal, type DealDraft, type DealFields } from "./dealInput.js";

/** Trims and checks a draft, refusing it as invalid_input with the first problem. */
export function checkedDraft(draft: DealDraft): DealFields {
  const result = checkDeal(draft);
  if (!result.ok)
    throw new HandlerError("invalid_input", { field: result.field, message: result.message });
  return result.fields;
}

/** Rule 4, checked up front for a clear message; the member column check is the backstop. */
export async function requireCandidate(ctx: MutationContext, id: string) {
  const member = await ctx.members.get(id);
  if (member === null || !member.active) throw new HandlerError("not_a_member", { owner: id });
}

/** Maps the platform's refusal of a member assignment to the patch's own business error. */
export async function assigning<T>(write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "invalid_row")
      throw new HandlerError("not_a_member", { message: error.message });
    throw error;
  }
}

/** Adds a checked deal to Lead with its "created" activity, in the caller's transaction. */
export async function addLead(ctx: MutationContext, draft: DealDraft, owner: string | null) {
  const fields = checkedDraft(draft);
  if (owner !== null) await requireCandidate(ctx, owner);
  const now = new Date().toISOString();
  return assigning(async () => {
    const deal = await ctx.tables.deals.insert({
      ...fields,
      stage: "lead",
      owner,
      openedAt: now,
      stageEnteredAt: now,
      lastActivityAt: now
    });
    await ctx.tables.activity.insert({
      deal: deal.id,
      kind: "created",
      actor: ctx.viewer.user.id,
      toStage: "lead",
      assignee: owner,
      at: now
    });
    return deal;
  });
}
