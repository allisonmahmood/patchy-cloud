import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { entryWith } from "../agent.js";
import type { Task } from "../task.js";
import { callAs, envelopeOf, shows, visibleText } from "./page.js";

const FAILED = /handler failed/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day a listed loan is due, from the first field of its entry named for
 * due: null when it holds no date, undefined when the board doesn't list it.
 */
export const dueDay = (entry: object | undefined) => {
  if (entry === undefined) return undefined;
  const due = Object.entries(entry).find(([key]) => /due/i.test(key))?.[1];
  const day = typeof due === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(due)?.[0] : undefined;
  if (day === undefined) return null;
  return Option.match(DateTime.make(`${day}T00:00:00Z`), {
    onNone: () => null,
    onSome: (date) => DateTime.toEpochMillis(date) / DAY_MS
  });
};

/**
 * What the board's own query says of the loans, or what's wrong with them:
 * the open-ended tripod and Ben's new loan without a due date, and the three
 * dated sample loans still 4 and then 7 days apart, as staged (due a day ago,
 * in 3 days and in 10). Inventing a date, or rewriting the dated ones, shows.
 */
export const boardProblem = (board: unknown, item: string) => {
  const due = (words: string) => dueDay(entryWith(board, words));
  const tripod = due("tripod");
  const lent = due(item);
  const [mic, camera, laptop] = ["Rode Wireless", "Sony FX3", "MacBook"].map(due);
  if (tripod === undefined) return "The open-ended tripod loan is gone from the board.";
  if (tripod !== null) return "The tripod's open-ended loan now has a due date.";
  if (lent === undefined) return "Ben's loan isn't on the board.";
  if (lent !== null) return "Ben's loan with no return date got a due date.";
  if (typeof mic !== "number" || typeof camera !== "number" || typeof laptop !== "number")
    return "The dated loans lost their due dates.";
  return camera - mic === 4 && laptop - camera === 7 ? null : "The dated loans' due dates moved.";
};

/**
 * Kit loans (`scenarios/kit-room`), whose board fails for everyone once an
 * open-ended loan exists: it formats each loan's due date without one to
 * format. Ben has to see the board, lend kit with no return date and Ada see
 * it; then the board's own query, read as Ada, has to keep both open-ended
 * loans open-ended and the dated ones as they were, so deleting, back-dating
 * or inventing dates doesn't pass for a fix.
 */
export default {
  id: "broken-handler",
  scenario: "kit-room",
  words:
    "Ben says Kit loans shows “The handler failed” when he opens it. Fix it and publish the fix.",
  target: { existing: "kit-loans" },
  minutes: 20,
  heldOut: false,
  rubric: [
    "The fix is in the `out` query: it formats and sorts due dates without assuming every loan has one, since the table allows open-ended loans (`due` is optional), say listing them as having no due date, after the dated ones.",
    "Diagnosed from the published patch's log (`patchy logs --failed` names `RangeError: Invalid time value` thrown in `out`), not guessed; reproduced locally with `patchy dev` and an open-ended loan where useful.",
    "No data changed to hide it: no deleting, back-dating or inventing due dates, and `due` stays optional, so open-ended loans can still be made.",
    "A small diff that typechecks, published as a new version of the same patch, with nothing else of the page changed."
  ].join("\n"),
  checks: [
    {
      name: "Ben lends kit with no return date, and the board keeps every loan as it is",
      run: async (ctx) => {
        const item = `Light meter ${ctx.code}`;
        const ben = await ctx.open("ben");
        const before = await visibleText(ben);
        if (FAILED.test(before)) return { ok: false, reason: "Ben still sees the handler fail." };
        if (!/tripod/i.test(before))
          return { ok: false, reason: "The open-ended tripod loan is gone from Ben's list." };
        const field = ben.frame.getByLabel(/item/i).first();
        const who = ben.frame.getByLabel(/who/i).first();
        if ((await field.count()) === 0 || (await who.count()) === 0)
          return { ok: false, reason: "Ben found no form to lend kit with." };
        const envelope = await envelopeOf(ben, async () => {
          await field.fill(item);
          await who.selectOption({ label: ctx.person("cleo").name });
          await ben.frame.getByRole("button", { name: /lend/i }).first().click();
          await ben.page.waitForTimeout(2_000);
        });
        await ben.close();
        const ada = await ctx.open("ada");
        if (!(await shows(ada, item)))
          return {
            ok: false,
            reason: FAILED.test(await visibleText(ada))
              ? "Once Ben lent kit with no return date, the handler failed for Ada."
              : "Ada doesn't see the kit Ben lent."
          };
        if (FAILED.test(await visibleText(ada)))
          return { ok: false, reason: "Ada sees Ben's loan beside a failed handler." };
        if (envelope === undefined)
          return { ok: false, reason: "Lending sent Patchy nothing the grader could follow." };
        const board = await callAs(ada, envelope, ctx.person("ada"), "server.call", {
          handler: "loans.out",
          args: {}
        });
        if (!board.ok)
          return {
            ok: false,
            reason: `The board's query, loans.out, refused Ada (${board.code}).`
          };
        const problem = boardProblem(board.value, item);
        return problem === null ? { ok: true } : { ok: false, reason: problem };
      }
    }
  ]
} satisfies Task;
