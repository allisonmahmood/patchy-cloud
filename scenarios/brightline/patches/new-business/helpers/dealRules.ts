// Server-only: the checks and writes behind every deal change, shared by the page's handlers
// (server/deals.ts) and the agent area (server/agent.ts), so an agent can never do what the
// person it acts for could not. Each write stamps the acting agent on its activity row; a
// person working in the page leaves it null.
import type { Id } from "patchy/config";
import { HandlerError, type MutationContext } from "../patchy/_generated/server.js";
import {
  LOST_REASONS,
  MAX_NOTE,
  STAGE_LABELS,
  missingFor,
  needsOwnerOrAdmin,
  type LostReason,
  type Stage
} from "./pipeline.js";

/** The fields a stage move reads. */
interface Movable {
  readonly id: Id<"deals">;
  readonly stage: string;
  readonly value: number | null;
  readonly owner: string | null;
}

export async function requireDeal(ctx: MutationContext, id: string) {
  const deal = await ctx.tables.deals.get(id as Id<"deals">);
  if (deal === null)
    throw new HandlerError("not_found", { deal: id, message: "No deal has that id." });
  return deal;
}

/** Rule 2's check, naming the owner so the page and agents can say who may act. */
export async function requireOwnerOrAdmin(
  ctx: MutationContext,
  deal: { readonly owner: string | null },
  action: "close" | "reopen" | "reassign"
) {
  if (ctx.viewer.admin || deal.owner === ctx.viewer.user.id) return;
  const owner = deal.owner === null ? null : await ctx.members.get(deal.owner);
  const doing = {
    close: "mark this deal won or lost",
    reopen: "reopen this deal",
    reassign: "hand this deal to someone else"
  }[action];
  throw new HandlerError("owner_or_admin_only", {
    action,
    owner: owner?.name ?? null,
    message:
      owner === null
        ? `Only an admin can ${doing}: it has no owner.`
        : `Only ${owner.name} (the owner) or an admin can ${doing}.`
  });
}

/** Rule 4, checked up front for a clear message; the member column check is the backstop. */
export async function requireCandidate(ctx: MutationContext, id: string) {
  const member = await ctx.members.get(id);
  if (member === null || !member.active)
    throw new HandlerError("not_a_member", {
      owner: id,
      message: "That person isn't an active member of the studio, so they can't own deals."
    });
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

/**
 * The one way a deal changes stage, for drag and drop, the drawer and agents alike.
 * Rule 2: entering or leaving Won/Lost needs the owner or an admin.
 * Rule 1: Proposal, Negotiation and Won need a value above zero and an owner.
 * Rule 3: Lost needs a reason, kept on the deal and in the move's timeline note; any other
 * stage clears it, so reopening a deal forgets why it was lost.
 */
export async function moveStage<D extends Movable>(
  ctx: MutationContext,
  deal: D,
  stage: Stage,
  reason: LostReason | null
) {
  if (deal.stage === stage) return deal;
  const lostReason = stage === "lost" ? reason : null;
  if (stage === "lost" && lostReason === null)
    throw new HandlerError("reason_required", {
      message: `Marking a deal lost needs a reason: one of ${LOST_REASONS.join(", ")}.`
    });
  if (needsOwnerOrAdmin(deal.stage, stage))
    await requireOwnerOrAdmin(ctx, deal, stage === "won" || stage === "lost" ? "close" : "reopen");
  const missing = missingFor(stage, deal);
  if (missing.length > 0)
    throw new HandlerError("needs_value_and_owner", {
      stage,
      missing,
      message: `${STAGE_LABELS[stage]} needs ${missing.map((field) => (field === "value" ? "a value above zero" : "an owner")).join(" and ")} first. Set ${missing.length > 1 ? "them" : "it"} on the deal in New Business, then move it again.`
    });

  const now = new Date().toISOString();
  const updated = await ctx.tables.deals.update(deal.id, {
    stage,
    lostReason,
    stageEnteredAt: now,
    lastActivityAt: now
  });
  await ctx.tables.activity.insert({
    deal: deal.id,
    kind: "moved",
    actor: ctx.viewer.user.id,
    agent: ctx.agent?.name ?? null,
    fromStage: deal.stage,
    toStage: stage,
    note: lostReason,
    at: now
  });
  return updated;
}

/** Adds a note to a deal's timeline. */
export async function writeNote(ctx: MutationContext, deal: Id<"deals">, text: string) {
  const note = text.trim();
  if (note === "")
    throw new HandlerError("invalid_input", { field: "note", message: "Write a note first." });
  if (note.length > MAX_NOTE)
    throw new HandlerError("invalid_input", {
      field: "note",
      message: "Keep notes under 2,000 characters."
    });
  const now = new Date().toISOString();
  await ctx.tables.deals.update(deal, { lastActivityAt: now });
  return ctx.tables.activity.insert({
    deal,
    kind: "note",
    actor: ctx.viewer.user.id,
    agent: ctx.agent?.name ?? null,
    note,
    at: now
  });
}
