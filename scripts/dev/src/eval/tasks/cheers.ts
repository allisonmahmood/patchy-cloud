import { countsByPlace, steadyRise, type Task } from "../task.js";

/**
 * The most common real first patch: a button the company presses together.
 * Ben cheers, then Cleo, and Ada, opening it fresh before and after each,
 * sees the same count go up by one each time: the count is stored and
 * shared, not the page's own.
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
      name: "each cheer reaches a third colleague",
      run: async (ctx) => {
        const adaSees = async () => countsByPlace((await ctx.open("ada")).frame);
        const seen = [await adaSees()];
        for (const person of ["ben", "cleo"]) {
          const { page, frame } = await ctx.open(person);
          const button = frame.getByRole("button", { name: /cheer/i }).first();
          if ((await button.count()) === 0)
            return { ok: false, reason: `${person} found no button named for cheering.` };
          await button.click();
          await page.waitForTimeout(1_500);
          seen.push(await adaSees());
        }
        return steadyRise(seen)
          ? { ok: true }
          : {
              ok: false,
              reason: `No number Ada sees went up by one after Ben's cheer and again after Cleo's (Ada saw ${seen.map((counts) => [...counts.values()].join(" ") || "none").join(" → ")}).`
            };
      }
    }
  ]
} satisfies Task;
