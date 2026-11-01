import type { Opened, Task } from "../task.js";
import { approve, decisionShown, emptyField, fillRest, formAround, reveal } from "./page.js";

/** A 1×1 PNG: the receipt a person attaches. */
const RECEIPT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const AMOUNT = /amount|cost|how much|total|price|\$/i;
const REASON = /reason|description|purpose|what|details|note|title|why|memo|justification|for\b/i;

/**
 * Asks for money the way a person would: opens the form if one waits behind a
 * button, types an amount and the reason, attaches the receipt, fills
 * anything else the form requires and sends it. The reason the request
 * couldn't be made, or null once it was sent.
 */
const ask = async (view: Opened, reason: string, receipt: string) => {
  const { frame, page } = view;
  let amount = await emptyField(frame, AMOUNT);
  if (amount === undefined) {
    const opener = frame.getByRole("button", { name: /new|request|submit|add|create|\+/i });
    if ((await opener.count()) === 0) return "found no amount to fill in or button to start one";
    await opener.first().click();
    await page.waitForTimeout(1_000);
    amount = await emptyField(frame, AMOUNT);
  }
  if (amount === undefined) return "found no amount to fill in";
  await amount.fill("42");
  const words = await emptyField(frame, REASON);
  if (words === undefined) return "found no field for the reason";
  await words.fill(reason);
  const file = frame.locator('input[type="file"]');
  if ((await file.count()) === 0) return "found no way to attach a receipt";
  await file.first().setInputFiles({ name: receipt, mimeType: "image/png", buffer: RECEIPT });
  const form = await formAround(frame, amount);
  if (form === undefined) return "found no button to send the request";
  await fillRest(form.scope);
  await form.send.click();
  await reveal(view, reason);
  return null;
};

/**
 * Whether the request holding `reason` shows its receipt: the file's name,
 * or a link, button or image that says receipt, attachment or file, in the
 * part of the page around the request but short of the form a receipt is
 * attached in. Looked for in the list, then in whatever opens on a click.
 */
const showsReceipt = async (view: Opened, reason: string, receipt: string) => {
  const look = () =>
    view.frame.locator("body").evaluate(
      (body, { reason, receipt }) => {
        if ((body.textContent ?? "").includes(receipt)) return true;
        const said = /receipt|attachment|download|view file|open file/i;
        const names = (part: Element) =>
          [
            part.textContent,
            part.getAttribute("aria-label"),
            part.getAttribute("alt"),
            part.getAttribute("title")
          ].some((words) => said.test(words ?? ""));
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (!(node.textContent ?? "").includes(reason)) continue;
          for (let part = node.parentElement; part !== null && part !== body;) {
            if (part.querySelector('input[type="file"]') !== null) break;
            if (
              [...part.querySelectorAll("a, button, [role=link], [role=button], img")].some(names)
            )
              return true;
            part = part.parentElement;
          }
        }
        return false;
      },
      { reason, receipt }
    );
  if (await look()) return true;
  await view.frame.getByText(reason).first().click();
  await view.page.waitForTimeout(1_000);
  return look();
};

/**
 * Spend requests with a rule the page can't keep alone: only admins decide.
 * Ben asks with a receipt and Ada sees both. Then Ben, and Cleo, another
 * member, each try to approve a request of Ben's, which must leave it
 * undecided, before Ada approves it and Ben sees the decision.
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
      name: "Ben asks with a receipt, and Ada sees the request and its receipt",
      run: async (ctx) => {
        const reason = `Team offsite snacks ${ctx.code}`;
        const receipt = `receipt-${ctx.code}.png`;
        const ben = await ctx.open("ben");
        const refused = await ask(ben, reason, receipt);
        await ben.close();
        if (refused !== null) return { ok: false, reason: `Ben ${refused}.` };
        const ada = await ctx.open("ada");
        if (!(await reveal(ada, reason)))
          return { ok: false, reason: "Ada doesn't see the request Ben sent." };
        return (await showsReceipt(ada, reason, receipt))
          ? { ok: true }
          : { ok: false, reason: "Ada sees Ben's request but nothing of its receipt." };
      }
    },
    {
      name: "only an admin's approval counts, and Ben sees it",
      run: async (ctx) => {
        const reason = `Client lunch with Harbor ${ctx.code}`;
        const ben = await ctx.open("ben");
        const refused = await ask(ben, reason, `lunch-${ctx.code}.png`);
        await ben.close();
        if (refused !== null) return { ok: false, reason: `Ben ${refused}.` };
        for (const member of ["ben", "cleo"]) {
          const view = await ctx.open(member);
          // A member who can't find Ben's request can't approve it either.
          if (await reveal(view, reason)) await approve(view, reason);
          await view.close();
          const after = await ctx.open("ben");
          if (!(await reveal(after, reason)))
            return {
              ok: false,
              reason: `Ben can't find his request after ${ctx.person(member).name} tried to approve it.`
            };
          const seen = await decisionShown(after, reason);
          await after.close();
          if (seen === "approved")
            return {
              ok: false,
              reason: `${ctx.person(member).name}, a member, could approve Ben's request.`
            };
        }
        const ada = await ctx.open("ada");
        if (!(await reveal(ada, reason)))
          return { ok: false, reason: "Ada doesn't see the request Ben sent." };
        if (!(await approve(ada, reason)))
          return { ok: false, reason: "Ada found no Approve for Ben's request." };
        await ada.close();
        const later = await ctx.open("ben");
        if (!(await reveal(later, reason)))
          return { ok: false, reason: "Ben no longer sees his request." };
        const seen = await decisionShown(later, reason);
        return seen === "approved"
          ? { ok: true }
          : {
              ok: false,
              reason: `After Ada approved it, Ben's request shows ${seen ?? "no decision"}.`
            };
      }
    }
  ]
} satisfies Task;
