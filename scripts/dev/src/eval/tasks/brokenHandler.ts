import type { Task } from "../task.js";
import { shows, visibleText } from "./page.js";

const FAILED = /handler failed/i;

/**
 * Kit loans (`scenarios/kit-room`), whose board fails for everyone once an
 * open-ended loan exists: it formats each loan's due date without one to
 * format. The open-ended tripod from the sample data has to stay listed, so
 * deleting or back-dating loans doesn't pass for a fix, and a new open-ended
 * loan of Ben's has to show for Ada, so neither does patching the one row.
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
    "No data changed to hide it: no deleting or back-dating loans, and `due` stays optional, so open-ended loans can still be made.",
    "A small diff that typechecks, published as a new version of the same patch, with nothing else of the page changed."
  ].join("\n"),
  checks: [
    {
      name: "Ben sees the open-ended loan, lends kit with no return date, and Ada sees it",
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
        await field.fill(item);
        await who.selectOption({ label: ctx.person("cleo").name });
        await ben.frame.getByRole("button", { name: /lend/i }).first().click();
        await ben.page.waitForTimeout(2_000);
        await ben.close();
        const ada = await ctx.open("ada");
        if (!(await shows(ada, item)))
          return {
            ok: false,
            reason: FAILED.test(await visibleText(ada))
              ? "Once Ben lent kit with no return date, the handler failed for Ada."
              : "Ada doesn't see the kit Ben lent."
          };
        return FAILED.test(await visibleText(ada))
          ? { ok: false, reason: "Ada sees Ben's loan beside a failed handler." }
          : { ok: true };
      }
    }
  ]
} satisfies Task;
