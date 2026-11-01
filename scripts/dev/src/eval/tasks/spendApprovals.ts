import type { CheckContext, CheckOutcome, Opened, Task } from "../task.js";
import {
  around,
  chooseField,
  decide,
  decisionShown,
  fillRest,
  formAround,
  reveal,
  servesFile
} from "./page.js";

/** A 1×1 PNG: the receipt a person attaches. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** A receipt of its own: the PNG with `marker` after its end, which image readers ignore. */
const receipt = (marker: string) => Buffer.concat([PNG, Buffer.from(`\n${marker}\n`)]);

const AMOUNT = /amount|cost|how much|total|price|\$/i;
const REASON = /reason|description|purpose|what|details|note|title|why|memo|justification|for\b/i;

/**
 * Asks for money the way a person would: opens the form if one waits behind a
 * button, types an amount and the reason, attaches a receipt holding
 * `marker`, fills anything else the form holds and sends it. The reason the
 * request couldn't be made, or null once it was sent.
 */
const ask = async (view: Opened, reason: string, marker: string) => {
  const { frame, page } = view;
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
    name: `receipt-${marker}.png`,
    mimeType: "image/png",
    buffer: receipt(marker)
  });
  const form = await formAround(frame);
  if (form === undefined) return "found no button to send the request";
  await fillRest(form.scope);
  await form.send.click();
  await reveal(view, reason);
  return null;
};

/** Ben asks for money with a receipt; the check's failure when he couldn't. */
const benAsks = async (ctx: CheckContext, reason: string, marker: string) => {
  const ben = await ctx.open("ben");
  const refused = await ask(ben, reason, marker);
  await ben.close();
  return refused === null ? null : ({ ok: false, reason: `Ben ${refused}.` } as const);
};

const RECEIPT_CONTROL = /receipt|attachment|download|view file|open file|\.png/i;

/**
 * Whether Ada can open the receipt of the request holding `reason`: a file
 * Patchy serves her holds its marker once she opens the request and presses
 * what says receipt in it. A saved file name, or a button with nothing
 * behind it, serves nothing.
 */
const adaOpensReceipt = async (ada: Opened, reason: string, marker: string) =>
  servesFile(ada, marker, async () => {
    // From a fresh load, so a preview the page fetches as it renders is seen too.
    await ada.page.reload();
    if (!(await reveal(ada, reason))) return;
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

/**
 * Only an admin's decision counts, tried against the server: Ben asks, Ada
 * presses Approve (or Reject), and the change her page sends is held back
 * while Ben, who asked, and Cleo, another member, each send the same change
 * from their own pages. Each must be refused by the patch, or leave the
 * request undecided. Then Ada's goes through and Ben sees the decision.
 */
const onlyAdmins =
  (which: keyof typeof DECIDED) =>
  async (ctx: CheckContext): Promise<CheckOutcome> => {
    const decided = DECIDED[which];
    const reason = `${which === "approve" ? "Client lunch with Harbor" : "Standing desk"} ${ctx.code}`;
    const refused = await benAsks(ctx, reason, `${ctx.code}-${which}`);
    if (refused !== null) return refused;
    const ada = await ctx.open("ada");
    if (!(await reveal(ada, reason)))
      return { ok: false, reason: "Ada doesn't see the request Ben sent." };
    const pressed = await decide(ada, reason, which, true);
    if (pressed === null)
      return { ok: false, reason: `Ada found no way to ${which} Ben's request.` };
    if (pressed.held === undefined)
      return {
        ok: false,
        reason: `Ada's ${which} sent Patchy no change for the grader to try as a member.`
      };
    for (const member of ["ben", "cleo"]) {
      const view = await ctx.open(member);
      const answer = await pressed.held.tryAs(view, ctx.person(member));
      await view.close();
      if (!answer.ok && !answer.byHandler)
        return {
          ok: false,
          reason: `Patchy itself refused the grader's try as ${ctx.person(member).name} (${answer.code}), so it can't tell what the patch allows.`
        };
      if (!answer.ok) {
        if (pressed.held.handler !== null) ctx.expectRefusal(member, pressed.held.handler);
        continue;
      }
      // Taken: a handler may still change nothing for someone who isn't an admin.
      const after = await ctx.open("ben");
      const seen = (await reveal(after, reason)) ? await decisionShown(after, reason) : null;
      await after.close();
      if (seen === decided)
        return {
          ok: false,
          reason: `Patchy let ${ctx.person(member).name}, a member, ${which} Ben's request.`
        };
    }
    await pressed.held.release();
    await ada.close();
    const later = await ctx.open("ben");
    if (!(await reveal(later, reason)))
      return { ok: false, reason: "Ben no longer sees his request." };
    const seen = await decisionShown(later, reason);
    return seen === decided
      ? { ok: true }
      : {
          ok: false,
          reason: `After Ada's ${which}, Ben's request shows ${seen ?? "no decision"}.`
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
        const refused = await benAsks(ctx, reason, marker);
        if (refused !== null) return refused;
        const ada = await ctx.open("ada");
        if (!(await reveal(ada, reason)))
          return { ok: false, reason: "Ada doesn't see the request Ben sent." };
        return (await adaOpensReceipt(ada, reason, marker))
          ? { ok: true }
          : { ok: false, reason: "Ada sees Ben's request but can't open the receipt he attached." };
      }
    },
    { name: "only an admin's approval counts, and Ben sees it", run: onlyAdmins("approve") },
    { name: "only an admin's rejection counts, and Ben sees it", run: onlyAdmins("reject") }
  ]
} satisfies Task;
