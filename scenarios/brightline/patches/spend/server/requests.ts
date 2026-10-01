import { action, HandlerError, mutation, query, t } from "../patchy/_generated/server.js";
import type { MutationContext, QueryContext } from "../patchy/_generated/server.js";
import type { Id } from "patchy/config";
import {
  adminApprovalCents,
  categories,
  checkReceipt,
  checkRequest,
  refusals,
  safeFileName,
  type Refusal
} from "../helpers/spend.js";

// The page calls only these handlers. Every spend rule is enforced here, against
// ctx.viewer, so nobody can skip a rule by calling a handler from devtools.

const refuse = (code: Refusal) => new HandlerError(code, { message: refusals[code] });

const person = t.object({
  id: t.text(),
  name: t.text(),
  email: t.text(),
  admin: t.boolean(),
  active: t.boolean()
});

/** Resolve the distinct member ids a screen shows, skipping unknown ids. */
async function people(ctx: Pick<QueryContext, "members">, ids: readonly (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return [];
  return (await ctx.members.getMany(unique)).filter((member) => member !== null);
}

/** Every request, newest first, with the people the list shows. */
export const list = query({
  args: {},
  result: t.object({ requests: t.array(t.row("requests")), people: t.array(person) }),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.requests.list({
      index: "bySubmitted",
      order: "desc",
      limit: 1000
    });
    return {
      requests: rows,
      people: await people(
        ctx,
        rows.flatMap((row) => [row.requester, row.approver, row.paidBy])
      )
    };
  }
});

/** One request with its audit trail and a viewer-bound handle for its receipt. */
export const detail = query({
  args: { id: t.text() },
  result: t.nullable(
    t.object({
      request: t.row("requests"),
      events: t.array(t.row("events")),
      receipt: t.nullable(
        t.object({
          handle: t.fileHandle(),
          name: t.text(),
          size: t.integer(),
          contentType: t.text()
        })
      ),
      people: t.array(person)
    })
  ),
  handler: async (ctx, args) => {
    const request = await ctx.tables.requests.get(args.id as Id<"requests">);
    if (request === null) return null;
    const { rows } = await ctx.tables.events.list({
      index: "request",
      eq: { request: request.id },
      limit: 500
    });
    const events = [...rows].sort((a, b) => a.at.localeCompare(b.at));
    const file = request.receipt === null ? null : await ctx.files.receipts.stat(request.receipt);
    return {
      request,
      events,
      receipt:
        file === null
          ? null
          : {
              handle: file.handle,
              name: file.name.split("/").at(-1) ?? file.name,
              size: file.size,
              contentType: file.contentType
            },
      people: await people(ctx, [
        request.requester,
        request.approver,
        request.paidBy,
        ...events.map((event) => event.actor)
      ])
    };
  }
});

const requestFields = {
  title: t.text(),
  project: t.text(),
  category: t.enum(categories),
  amountCents: t.integer()
};

/**
 * Insert a submitted request and its audit event in one transaction.
 * The submit action runs this after adopting the receipt. Called directly, it
 * still only accepts a receipt the viewer adopted through submit and nobody
 * has claimed, so the receipt rule cannot be satisfied with a made-up name.
 */
export const create = mutation({
  args: { ...requestFields, receiptFile: t.nullable(t.text()) },
  result: t.row("requests"),
  errors: [
    "missing_title",
    "missing_project",
    "invalid_amount",
    "receipt_required",
    "receipt_unavailable"
  ],
  handler: async (ctx, args) => {
    const me = ctx.viewer.user.id;
    const claim =
      args.receiptFile === null
        ? null
        : await ctx.tables.receiptFiles.get(args.receiptFile as Id<"receiptFiles">);
    if (
      args.receiptFile !== null &&
      (claim === null || claim.uploader !== me || claim.request !== null)
    )
      throw refuse("receipt_unavailable");
    const broken = checkRequest(args, claim !== null);
    if (broken !== null) throw refuse(broken);
    const now = new Date().toISOString();
    const request = await ctx.tables.requests.insert({
      title: args.title.trim(),
      project: args.project.trim(),
      category: args.category,
      amountCents: args.amountCents,
      status: "submitted",
      requester: me,
      receipt: claim?.name ?? null,
      submittedAt: now
    });
    if (claim !== null) await ctx.tables.receiptFiles.update(claim.id, { request: request.id });
    await ctx.tables.events.insert({ request: request.id, kind: "submitted", actor: me, at: now });
    return request;
  }
});

/**
 * Submit a request as the signed-in viewer. A staged receipt is checked and
 * adopted into the receipts store first, then the create mutation runs.
 * Adoption and the mutation are not one transaction: if the mutation fails the
 * file stays stored, and not_saved hands back keptReceipt so the person can
 * retry without uploading it again.
 */
export const submit = action({
  args: {
    ...requestFields,
    receipt: t.upload().optional(),
    fileName: t.text().optional(),
    keptReceipt: t.text().optional()
  },
  result: t.object({ id: t.text() }),
  errors: [
    "missing_title",
    "missing_project",
    "invalid_amount",
    "receipt_required",
    "receipt_type",
    "receipt_too_large",
    "receipt_unavailable",
    "not_saved"
  ],
  handler: async (ctx, args) => {
    const fields = {
      title: args.title,
      project: args.project,
      category: args.category,
      amountCents: args.amountCents
    };
    const broken = checkRequest(
      fields,
      args.receipt !== undefined || args.keptReceipt !== undefined
    );
    if (broken !== null) throw refuse(broken);

    if (args.receipt === undefined) {
      const request = await ctx.run.requests.create({
        ...fields,
        receiptFile: args.keptReceipt ?? null
      });
      return { id: request.id };
    }

    const wrongFile = checkReceipt(args.receipt.contentType, args.receipt.size);
    if (wrongFile !== null) throw refuse(wrongFile);
    const me = ctx.viewer.user.id;
    const name = `${me}/${crypto.randomUUID()}/${safeFileName(args.fileName ?? "receipt")}`;
    await ctx.files.receipts.put(name, args.receipt);
    const claim = await ctx.tables.receiptFiles.insert({ name, uploader: me });
    try {
      const request = await ctx.run.requests.create({ ...fields, receiptFile: claim.id });
      return { id: request.id };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      ctx.log("Receipt stored but the request was not saved", { receipt: name, reason });
      throw new HandlerError("not_saved", {
        message: refusals.not_saved,
        keptReceipt: claim.id,
        reason
      });
    }
  }
});

async function findRequest(ctx: MutationContext, id: string) {
  const request = await ctx.tables.requests.get(id as Id<"requests">);
  if (request === null) throw refuse("request_missing");
  return request;
}

/** A trimmed note, null when blank; refuses notes over 1,000 characters. */
function cleanNote(note: string | undefined) {
  const text = (note ?? "").trim();
  if (text.length > 1000) throw refuse("note_too_long");
  return text === "" ? null : text;
}

/** Approve a submitted request: not your own, and $2,500 or more needs an admin. */
export const approve = mutation({
  args: { id: t.text(), note: t.text().optional() },
  result: t.row("requests"),
  errors: ["request_missing", "not_submitted", "own_approval", "admin_required", "note_too_long"],
  handler: async (ctx, args) => {
    const request = await findRequest(ctx, args.id);
    const me = ctx.viewer.user.id;
    if (request.status !== "submitted") throw refuse("not_submitted");
    if (request.requester === me) throw refuse("own_approval");
    if (request.amountCents >= adminApprovalCents && !ctx.viewer.admin)
      throw refuse("admin_required");
    const note = cleanNote(args.note);
    const now = new Date().toISOString();
    const updated = await ctx.tables.requests.update(request.id, {
      status: "approved",
      approver: me,
      decidedAt: now,
      decisionNote: note
    });
    await ctx.tables.events.insert({
      request: request.id,
      kind: "approved",
      actor: me,
      note,
      at: now
    });
    return updated;
  }
});

/** Reject a submitted request with a note saying why; not your own. */
export const reject = mutation({
  args: { id: t.text(), note: t.text() },
  result: t.row("requests"),
  errors: ["request_missing", "not_submitted", "own_rejection", "note_required", "note_too_long"],
  handler: async (ctx, args) => {
    const request = await findRequest(ctx, args.id);
    const me = ctx.viewer.user.id;
    if (request.status !== "submitted") throw refuse("not_submitted");
    if (request.requester === me) throw refuse("own_rejection");
    const note = cleanNote(args.note);
    if (note === null) throw refuse("note_required");
    const now = new Date().toISOString();
    const updated = await ctx.tables.requests.update(request.id, {
      status: "rejected",
      approver: me,
      decidedAt: now,
      decisionNote: note
    });
    await ctx.tables.events.insert({
      request: request.id,
      kind: "rejected",
      actor: me,
      note,
      at: now
    });
    return updated;
  }
});

/** Admins mark an approved request as paid. */
export const markPaid = mutation({
  args: { id: t.text() },
  result: t.row("requests"),
  errors: ["request_missing", "admins_only", "not_approved"],
  handler: async (ctx, args) => {
    if (!ctx.viewer.admin) throw refuse("admins_only");
    const request = await findRequest(ctx, args.id);
    if (request.status !== "approved") throw refuse("not_approved");
    const me = ctx.viewer.user.id;
    const now = new Date().toISOString();
    const updated = await ctx.tables.requests.update(request.id, {
      status: "paid",
      paidBy: me,
      paidAt: now
    });
    await ctx.tables.events.insert({ request: request.id, kind: "paid", actor: me, at: now });
    return updated;
  }
});

/** Anyone who can open the tool can add a note to a request's audit trail. */
export const addNote = mutation({
  args: { id: t.text(), note: t.text() },
  result: t.row("events"),
  errors: ["request_missing", "empty_note", "note_too_long"],
  handler: async (ctx, args) => {
    const request = await findRequest(ctx, args.id);
    const note = cleanNote(args.note);
    if (note === null) throw refuse("empty_note");
    return ctx.tables.events.insert({
      request: request.id,
      kind: "note",
      actor: ctx.viewer.user.id,
      note,
      at: new Date().toISOString()
    });
  }
});
