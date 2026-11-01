import { integersIn, rose, type Task } from "../task.js";

/**
 * The most common real first patch: a button the company presses together.
 * Two colleagues cheer, and a third, opening it fresh, sees the count up by
 * two: the count is stored and shared, not the page's own.
 */
export default {
  id: "cheers",
  scenario: "team",
  words:
    "Make a patch where anyone at our company can press a button to cheer our launch, and see how many cheers there have been. Publish it.",
  target: { create: "repo" },
  minutes: 15,
  heldOut: false,
  rubric: [
    "One owned table of cheers (or a single counter row) shared by the company; tier 1 is enough, since nothing must be enforced against a viewer and nothing outside the patch is needed.",
    "The count is read with a live query, so every open page updates; a press is one insert or one atomic increment, never read-modify-write of a total from the page.",
    "The page starts in the company look and has a clear empty state (no cheers yet).",
    "Small and plain: no server code, no extra dependencies."
  ].join("\n"),
  checks: [
    {
      name: "two cheers reach a third colleague",
      run: async (ctx) => {
        const shown = async (person: string) =>
          integersIn(await (await ctx.open(person)).frame.locator("body").innerText());
        const before = await shown("ada");
        for (const person of ["ben", "cleo"]) {
          const { page, frame } = await ctx.open(person);
          const button = frame.getByRole("button", { name: /cheer/i }).first();
          if ((await button.count()) === 0)
            return { ok: false, reason: `${person} found no button named for cheering.` };
          await button.click();
          await page.waitForTimeout(1_500);
        }
        const after = await shown("ada");
        return rose(before, after, 2)
          ? { ok: true }
          : {
              ok: false,
              reason: `After Ben and Cleo cheered, Ada saw ${after.join(", ") || "no numbers"} where Ada had seen ${before.join(", ") || "no numbers"}.`
            };
      }
    }
  ]
} satisfies Task;
