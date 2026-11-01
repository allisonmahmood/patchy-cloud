import { countFollows, countsBeside, type Task } from "../task.js";

/**
 * The most common real first patch: a button the company presses together.
 * Ada opens it fresh between every step: Ben visits without cheering (the
 * count must not move), then Ben cheers and Cleo cheers (up by one each). The
 * count is stored and shared, not the page's own, and a counter of visitors
 * or people present can't pass for it.
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
    "An exact total that everyone sees live and that stays right when people cheer at the same moment.",
    "Owned tables have no count, and tier 1 page writes are last-write-wins, so on today's Patchy the expert design is a tier 2 mutation that increments one counter row atomically (its transaction retries on conflict), read through a live query. A tier 1 counter row written from the page loses concurrent cheers; recounting every row on every change is correct but grows with every cheer.",
    "The page starts in the company look and has a clear empty state (no cheers yet).",
    "Small and plain: one table, one mutation, one query, no extra dependencies."
  ].join("\n"),
  checks: [
    {
      name: "each cheer reaches a third colleague",
      run: async (ctx) => {
        const adaSees = async () => {
          const view = await ctx.open("ada");
          const counts = countsBeside(await view.frame.locator("body").innerText(), "cheer");
          await view.close();
          return counts;
        };
        /** A visit, with or without a cheer; the reason it couldn't cheer, if it couldn't. */
        const visit = async (person: string, cheer: boolean) => {
          const { page, frame, close } = await ctx.open(person);
          if (cheer) {
            const button = frame.getByRole("button", { name: /cheer/i }).first();
            if ((await button.count()) === 0)
              return `${person} found no button named for cheering.`;
            await button.click();
            await page.waitForTimeout(1_500);
          }
          await close();
          return null;
        };
        const seen = [await adaSees()];
        for (const [person, cheer] of [
          ["ben", false],
          ["ben", true],
          ["cleo", true]
        ] as const) {
          const refused = await visit(person, cheer);
          if (refused !== null) return { ok: false, reason: refused };
          seen.push(await adaSees());
        }
        return countFollows(seen, [0, 0, 1, 2])
          ? { ok: true }
          : {
              ok: false,
              reason: `No cheers count Ada sees held while Ben only visited, then went up by one with Ben's cheer and again with Cleo's (Ada saw ${seen.map((counts) => counts.join(" ") || "none").join(" → ")}).`
            };
      }
    }
  ]
} satisfies Task;
