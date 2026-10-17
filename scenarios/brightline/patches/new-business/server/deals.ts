// Deal handlers. The page reads the board and a deal's timeline through the two queries and
// changes deals only through the mutations below; every mutation writes its activity row in
// the same transaction.
import type { Id } from "patchy/config";
import { HandlerError, mutation, query, t } from "../patchy/_generated/server.js";
import { checkDeal, type DealDraft, type DealFields } from "../helpers/dealInput.js";
import {
  assigning,
  moveStage,
  requireCandidate,
  requireDeal,
  requireOwnerOrAdmin,
  writeNote
} from "../helpers/dealRules.js";
import { personSchema, resolvePeople } from "../helpers/people.js";
import {
  COMMITTED_STAGES,
  LOST_REASONS,
  MAX_IMPORT_ROWS,
  SERVICES,
  SOURCES,
  STAGES,
  missingFor,
  type Stage
} from "../helpers/pipeline.js";

// ---------------------------------------------------------------------------------------------
// Reads

/** Every deal on the board, with the people who own them. */
export const board = query({
  args: {},
  result: t.object({ deals: t.array(t.row("deals")), people: t.array(personSchema) }),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.deals.list({ limit: 1000 });
    const people = await resolvePeople(
      ctx.members,
      rows.map((deal) => deal.owner)
    );
    return { deals: rows, people };
  }
});

/** One deal's activity, newest first, with the people who appear in it. */
export const timeline = query({
  args: { deal: t.text() },
  result: t.object({ events: t.array(t.row("activity")), people: t.array(personSchema) }),
  handler: async (ctx, args) => {
    const { rows } = await ctx.tables.activity.list({
      index: "timeline",
      eq: { deal: args.deal as Id<"deals"> },
      order: "desc",
      limit: 200
    });
    const people = await resolvePeople(
      ctx.members,
      rows.flatMap((event) => [event.actor, event.assignee])
    );
    return { events: rows, people };
  }
});

// ---------------------------------------------------------------------------------------------
// Writes

const draftArgs = {
  client: t.text(),
  title: t.text(),
  service: t.enum(SERVICES),
  value: t.nullable(t.integer()),
  source: t.enum(SOURCES),
  nextStep: t.nullable(t.text()),
  expectedClose: t.nullable(t.text())
};

/** Adds a deal to Lead. */
export const create = mutation({
  args: { ...draftArgs, owner: t.nullable(t.text()) },
  errors: ["invalid_input", "not_a_member"],
  result: t.row("deals"),
  handler: async (ctx, { owner, ...draft }) => {
    const fields = checked(draft);
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
});

/** The one way the page changes a deal's stage, from drag and drop or the drawer; see moveStage. */
export const move = mutation({
  args: { deal: t.text(), stage: t.enum(STAGES), reason: t.enum(LOST_REASONS).optional() },
  errors: ["not_found", "owner_or_admin_only", "needs_value_and_owner", "reason_required"],
  result: t.row("deals"),
  handler: async (ctx, args) =>
    moveStage(ctx, await requireDeal(ctx, args.deal), args.stage, args.reason ?? null)
});

/** Saves the drawer's details form. A committed deal keeps its value (rule 1 stays true). */
export const update = mutation({
  args: { deal: t.text(), ...draftArgs },
  errors: ["not_found", "invalid_input", "value_required"],
  result: t.row("deals"),
  handler: async (ctx, { deal: id, ...draft }) => {
    const deal = await requireDeal(ctx, id);
    const fields = checked(draft);
    if (missingFor(deal.stage, { value: fields.value, owner: deal.owner }).includes("value"))
      throw new HandlerError("value_required", { stage: deal.stage });

    const changes = describeChanges(deal, fields);
    if (changes.length === 0) return deal;
    const now = new Date().toISOString();
    const updated = await ctx.tables.deals.update(deal.id, { ...fields, lastActivityAt: now });
    await ctx.tables.activity.insert({
      deal: deal.id,
      kind: "edited",
      actor: ctx.viewer.user.id,
      note: changes.join(" · "),
      at: now
    });
    return updated;
  }
});

/**
 * Changes a deal's owner. Rule 4: the new owner must be a current member (the platform checks
 * member columns too). Anyone may pick up an unassigned deal; handing over an owned deal is the
 * owner's or an admin's call, which keeps rule 2 meaningful.
 */
export const assign = mutation({
  args: { deal: t.text(), owner: t.nullable(t.text()) },
  errors: ["not_found", "owner_or_admin_only", "owner_required", "not_a_member"],
  result: t.row("deals"),
  handler: async (ctx, args) => {
    const deal = await requireDeal(ctx, args.deal);
    if (deal.owner === args.owner) return deal;
    if (deal.owner !== null) await requireOwnerOrAdmin(ctx, deal, "reassign");
    if (args.owner === null && COMMITTED_STAGES.includes(deal.stage as Stage))
      throw new HandlerError("owner_required", { stage: deal.stage });
    if (args.owner !== null) await requireCandidate(ctx, args.owner);

    const now = new Date().toISOString();
    return assigning(async () => {
      const updated = await ctx.tables.deals.update(deal.id, {
        owner: args.owner,
        lastActivityAt: now
      });
      await ctx.tables.activity.insert({
        deal: deal.id,
        kind: "assigned",
        actor: ctx.viewer.user.id,
        assignee: args.owner,
        at: now
      });
      return updated;
    });
  }
});

/** Adds a note to a deal's timeline. */
export const addNote = mutation({
  args: { deal: t.text(), note: t.text() },
  errors: ["not_found", "invalid_input"],
  result: t.row("activity"),
  handler: async (ctx, args) => writeNote(ctx, (await requireDeal(ctx, args.deal)).id, args.note)
});

/**
 * Rule 5: imports CSV leads all-or-nothing. The page drops rows it flagged; any row that still
 * fails here refuses the whole import, so nothing is half-written.
 */
export const importLeads = mutation({
  args: { rows: t.array(t.object({ ...draftArgs, owner: t.nullable(t.text()) })) },
  errors: ["invalid_rows", "not_a_member"],
  result: t.object({ imported: t.integer() }),
  handler: async (ctx, args) => {
    if (args.rows.length === 0)
      throw new HandlerError("invalid_rows", {
        rows: [],
        message: "There are no valid rows to import."
      });
    if (args.rows.length > MAX_IMPORT_ROWS)
      throw new HandlerError("invalid_rows", {
        rows: [],
        message: `Import at most ${MAX_IMPORT_ROWS} leads at a time.`
      });

    const checkedRows = args.rows.map((row) => ({ owner: row.owner, result: checkDeal(row) }));
    const problems = checkedRows.flatMap(({ result }, index) =>
      result.ok ? [] : [{ row: index + 1, message: result.message }]
    );
    const owners = [
      ...new Set(args.rows.flatMap((row) => (row.owner === null ? [] : [row.owner])))
    ];
    const known = new Set(
      (await ctx.members.getMany(owners)).flatMap((member) => (member?.active ? [member.id] : []))
    );
    args.rows.forEach((row, index) => {
      if (row.owner !== null && !known.has(row.owner))
        problems.push({ row: index + 1, message: "The owner isn't an active member." });
    });
    if (problems.length > 0) throw new HandlerError("invalid_rows", { rows: problems });

    const now = new Date().toISOString();
    return assigning(async () => {
      const deals = await ctx.tables.deals.insertMany(
        checkedRows.flatMap(({ owner, result }) =>
          result.ok
            ? [
                {
                  ...result.fields,
                  stage: "lead",
                  owner,
                  openedAt: now,
                  stageEnteredAt: now,
                  lastActivityAt: now
                }
              ]
            : []
        )
      );
      await ctx.tables.activity.insertMany(
        deals.map((deal) => ({
          deal: deal.id,
          kind: "imported",
          actor: ctx.viewer.user.id,
          toStage: "lead",
          assignee: deal.owner,
          at: now
        }))
      );
      return { imported: deals.length };
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers; the rules every write shares live in helpers/dealRules.ts

function checked(draft: DealDraft): DealFields {
  const result = checkDeal(draft);
  if (!result.ok)
    throw new HandlerError("invalid_input", { field: result.field, message: result.message });
  return result.fields;
}

const usd = (value: number | null) =>
  value === null ? "no value" : `$${value.toLocaleString("en-US")}`;

/** A short, human summary of what an edit changed, for the timeline. */
function describeChanges(before: DealDraft, after: DealFields) {
  const changes: string[] = [];
  if (before.client !== after.client) changes.push(`client to ${after.client}`);
  if (before.title !== after.title) changes.push(`project to ${after.title}`);
  if (before.service !== after.service) changes.push(`service to ${after.service}`);
  if (before.value !== after.value)
    changes.push(`value ${usd(before.value)} → ${usd(after.value)}`);
  if (before.source !== after.source) changes.push(`source to ${after.source}`);
  if (before.nextStep !== after.nextStep)
    changes.push(
      after.nextStep === null ? "cleared the next step" : `next step: ${after.nextStep}`
    );
  if (before.expectedClose !== after.expectedClose)
    changes.push(
      after.expectedClose === null
        ? "cleared the expected close"
        : `expected close ${after.expectedClose}`
    );
  return changes;
}
