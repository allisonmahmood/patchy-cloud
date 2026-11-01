import {
  type CheckContext,
  type CheckOutcome,
  GraderTrouble,
  type Opened,
  type Task
} from "../task.js";
import {
  around,
  chooseField,
  decide,
  decisionOf,
  decisionShown,
  fillRest,
  formAround,
  reveal,
  servesFile,
  type ViewMemo
} from "./page.js";

/** A 1×1 PNG: the receipt a person attaches. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/**
 * A receipt of its own: the PNG with `marker` after its end, which image
 * readers ignore. Its file name doesn't carry the marker, so only these
 * bytes, served whole, can prove the upload was kept.
 */
export const receipt = (marker: string) => Buffer.concat([PNG, Buffer.from(`\n${marker}\n`)]);

const AMOUNT = /amount|cost|how much|total|price|\$/i;
const REASON = /reason|description|purpose|what|details|note|title|why|memo|justification|for\b/i;

/**
 * Asks for money the way a person would: opens the form if one waits behind a
 * button, types an amount and the reason, attaches a receipt holding
 * `marker`, fills anything else the form holds and sends it. The reason the
 * request couldn't be made, or null once it shows up among his requests.
 */
const ask = async (view: Opened, reason: string, marker: string, memo: ViewMemo) => {
  const { frame, page } = view;
  // Asking is deliberate, from opening the form to sending it: its writes reach Patchy, and
  // the barrier is up again only once they've been answered.
  const refused = await view.barrier.deliberately(async () => {
    let amount = await chooseField(frame, AMOUNT);
    if (amount === undefined) {
      const opener = frame.getByRole("button", { name: /new|request|submit|add|create|\+/i });
      if ((await opener.count()) === 0) return "found no amount to fill in or button to start one";
      await opener.first().click();
      await page.waitForTimeout(1_000);
      amount = await chooseField(frame, AMOUNT);
    }
    if (amount === undefined) return "found no amount to fill in";
    await amount.fill("42");
    const words = await chooseField(frame, REASON);
    if (words === undefined) return "found no field for the reason";
    await words.fill(reason);
    const file = frame.locator('input[type="file"]');
    if ((await file.count()) === 0) return "found no way to attach a receipt";
    await file.first().setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: receipt(marker)
    });
    const form = await formAround(frame);
    if (form === undefined) return "found no button to send the request";
    await fillRest(form.scope);
    await form.send.click();
    return null;
  });
  if (refused !== null) return refused;
  // Whoever asked sees their request; one that never shows up wasn't sent, whatever the page did.
  return (await reveal(view, reason, memo))
    ? null
    : "sent the request, but it never showed up for him on his starting view or behind its tabs and view toggles";
};

/** Ben asks for money with a receipt; the check's failure when he couldn't. */
const benAsks = async (ctx: CheckContext, reason: string, marker: string, memo: ViewMemo) => {
  const ben = await ctx.open("ben");
  const refused = await ask(ben, reason, marker, memo);
  await ben.close();
  return refused === null ? null : ({ ok: false, reason: `Ben ${refused}.` } as const);
};

const RECEIPT_CONTROL = /receipt|attachment|download|view file|open file|\.png/i;

/**
 * Whether Ada can open the receipt of the request holding `reason`: Patchy
 * serves her a file with exactly the receipt's bytes once she opens the
 * request and presses what says receipt in it. A saved file name, a button
 * with nothing behind it, or a file holding anything else serves nothing.
 */
const adaOpensReceipt = async (ada: Opened, reason: string, marker: string, memo: ViewMemo) =>
  servesFile(ada, receipt(marker), async () => {
    // From a fresh load, so a preview the page fetches as it renders is seen too.
    await ada.page.reload();
    if (!(await reveal(ada, reason, memo))) return;
    // Opening the request and its receipt only looks, behind the barrier: a "Remove receipt" can't write.
    await ada.frame.getByText(reason).first().click();
    await ada.page.waitForTimeout(2_000);
    for (const role of ["link", "button"] as const) {
      const controls = ada.frame.getByRole(role, { name: RECEIPT_CONTROL });
      for (const control of await around(ada.frame, reason, { has: controls })
        .getByRole(role, { name: RECEIPT_CONTROL })
        .all())
        if (await control.isVisible().catch(() => false)) {
          await control.click({ timeout: 5_000 }).catch(() => undefined);
          await ada.page.waitForTimeout(2_000);
        }
    }
  });

const DECIDED = { approve: "approved", reject: "rejected" } as const;

const ADA_MISSES =
  "Ada doesn't see the request Ben sent on her starting view or behind its tabs and view toggles.";

/** What Ben sees of his request: its decision, none shown, or undefined when he can't find it. */
type Shown = ReturnType<typeof decisionOf> | undefined;

/** Patchy's codes for a patch's handler failing on a try: the patch's answer, never expected. */
const PATCH_FAILED = new Set(["handler_failed", "handler_timeout"]);

/**
 * Only an admin's decision counts, tried against the server: Ben asks, then
 * Ada presses Approve (or Reject). Every call her press sends Patchy is held
 * back in turn while Ben, who asked, and Cleo, another member, each send the
 * same call from their own pages. With the call still held, Ben must see his
 * request just as he did before each try, refused or not, so neither a
 * refusal after the change committed nor Ada's own earlier calls are
 * mistaken. Each refusal a try draws is the check's own, so it doesn't fail
 * `opens ready`. The watch ends only once Ben sees Ada's decision right after
 * one of her held calls goes through: that call was the decision, and both
 * members tried it first. A decision that never shows that way fails.
 */
const onlyAdmins =
  (which: keyof typeof DECIDED) =>
  async (ctx: CheckContext): Promise<CheckOutcome> => {
    const decided = DECIDED[which];
    const reason = `${which === "approve" ? "Client lunch with Harbor" : "Standing desk"} ${ctx.code}`;
    // The views each found the request under, so later looks are one click, inside the
    // time a held call of Ada's has before her browser gives up on it.
    const benWay: ViewMemo = {};
    const adaWay: ViewMemo = {};
    const refused = await benAsks(ctx, reason, `${ctx.code}-${which}`, benWay);
    if (refused !== null) return refused;
    /** What Ben sees of his request's decision, from a fresh page; undefined when he can't find it. */
    const benSees = async (): Promise<Shown> => {
      const ben = await ctx.open("ben");
      const seen = (await reveal(ben, reason, benWay))
        ? await decisionShown(ben, reason)
        : undefined;
      await ben.close();
      return seen;
    };
    const before = await benSees();
    if (before === undefined)
      return {
        ok: false,
        reason:
          "Ben can't find the request he sent on his starting view or behind its tabs and view toggles."
      };
    if (before === "approved" || before === "rejected")
      return { ok: false, reason: `Ben's request shows ${before} before anyone decided it.` };
    const ada = await ctx.open("ada");
    if (!(await reveal(ada, reason, adaWay))) return { ok: false, reason: ADA_MISSES };
    let seen: Shown = before;
    const pressed = await decide(ada, reason, which, {
      probe: async (call) => {
        // What Ben sees with Ada's call held: her earlier calls may already have decided it.
        seen = await benSees();
        if (seen === decided)
          return `Ben's request was ${decided} before Ada's last call: her ${which} went through something the grader couldn't hold, so it couldn't try it as a member.`;
        for (const member of ["ben", "cleo"]) {
          const view = await ctx.open(member);
          const answer = await call.tryAs(view, ctx.person(member));
          await view.close();
          // Patchy refusing for any reason but the patch's own handler failing says nothing of the patch.
          if (!answer.ok && !answer.byHandler && !PATCH_FAILED.has(answer.code))
            throw new GraderTrouble({
              what: `Patchy itself refused the grader's try as ${ctx.person(member).name} (${answer.code}).`
            });
          const after = await benSees();
          if (after !== seen)
            return `${ctx.person(member).name}, a member, sent Ada's ${which} call${call.handler === null ? "" : ` (${call.handler})`} as their own, ${answer.ok ? "and" : "and was refused, but"} Ben's request then showed ${after ?? "nothing he could find"} instead of ${seen ?? "no decision"}.`;
          if (!answer.ok && answer.byHandler && call.handler !== null)
            ctx.expectRefusal({
              person: member,
              handler: call.handler,
              code: answer.code,
              at: answer.at
            });
        }
        return null;
      },
      took: async () => (seen = await benSees()) === decided
    });
    if (pressed === null)
      return { ok: false, reason: `Ada found no way to ${which} Ben's request.` };
    if (pressed.objection !== null) return { ok: false, reason: pressed.objection };
    await ada.close();
    if (pressed.took) return { ok: true };
    return {
      ok: false,
      reason:
        pressed.held === 0
          ? `Ada's ${which} sent Patchy nothing, and Ben's request shows ${seen ?? "no decision"}.`
          : `Ada's ${which} never took effect through a call the grader could try as a member: Ben's request shows ${seen ?? "no decision"}.`
    };
  };

/**
 * Spend requests with rules the page can't keep alone: only admins decide,
 * and a receipt is a file the patch keeps. Ben asks with a receipt and Ada
 * opens it. Then, for an approval and for a rejection on requests of their
 * own, members' tries are sent to the server before Ada's decision goes
 * through and Ben sees it.
 */
export default {
  id: "spend-approvals",
  scenario: "team",
  words:
    "Make a patch where anyone at our company can submit a spend request with an amount, a reason and a receipt. Only admins can approve or reject a request, and whoever asked should see the decision. Publish it.",
  target: { create: "repo" },
  tier: 2,
  minutes: 30,
  heldOut: false,
  rubric: [
    "Tier 2: only admins decide, a rule kept against the viewer, which only server handlers can do; at tier 1 any member's page could write any row.",
    "One owned table of requests: the amount in integer cents (or another exact unit), the reason, a status, the requester from `ctx.viewer` (never an argument), and who decided and when. Receipts in an owned file store, uploaded with the request and kept on its row.",
    "Approve and reject are mutations that check the viewer is an admin and the request is still undecided, refusing otherwise with declared errors; the decider is the viewer. Names come from the member directory.",
    "The page reads requests with a live query: a requester sees their requests and each decision, an admin sees what waits for them and can open the receipt. The amount is validated as positive.",
    "Clear empty states and errors, in the company look; no extra dependencies."
  ].join("\n"),
  checks: [
    {
      name: "Ben asks with a receipt, and Ada opens it",
      run: async (ctx) => {
        const reason = `Team offsite snacks ${ctx.code}`;
        const marker = `${ctx.code}-receipt`;
        const refused = await benAsks(ctx, reason, marker, {});
        if (refused !== null) return refused;
        const ada = await ctx.open("ada");
        const adaWay: ViewMemo = {};
        if (!(await reveal(ada, reason, adaWay))) return { ok: false, reason: ADA_MISSES };
        return (await adaOpensReceipt(ada, reason, marker, adaWay))
          ? { ok: true }
          : { ok: false, reason: "Ada sees Ben's request but can't open the receipt he attached." };
      }
    },
    { name: "only an admin's approval counts, and Ben sees it", run: onlyAdmins("approve") },
    { name: "only an admin's rejection counts, and Ben sees it", run: onlyAdmins("reject") }
  ]
} satisfies Task;
