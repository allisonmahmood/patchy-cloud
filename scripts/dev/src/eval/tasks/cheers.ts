import { integersIn, type Task } from "../task.js";

/**
 * The most common real first patch: a button the company presses together. A
 * colleague cheers, and another colleague opening it fresh sees the count go
 * up by one, so the count is shared and stored, not the page's own.
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
      name: "a cheer reaches a colleague",
      run: async (ctx) => {
        const before = await ctx.open("ben");
        const seen = integersIn(await before.frame.locator("body").innerText());
        const button = before.frame.getByRole("button", { name: /cheer/i }).first();
        if ((await button.count()) === 0)
          return { ok: false, reason: "Ben found no button named for cheering." };
        await button.click();
        await before.page.waitForTimeout(1_500);
        const after = await ctx.open("cleo");
        const now = integersIn(await after.frame.locator("body").innerText());
        return seen.some((count) => now.includes(count + 1))
          ? { ok: true }
          : {
              ok: false,
              reason: `After Ben cheered, Cleo saw ${now.join(", ") || "no numbers"} where Ben had seen ${seen.join(", ") || "no numbers"}.`
            };
      }
    }
  ]
} satisfies Task;
