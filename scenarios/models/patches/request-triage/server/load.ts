// PROTOTYPE load test: actions the slot driver calls. `model` makes one model call whose fake
// answer time the caller picks (the fake reads the marker in its input), then a little table
// work; `quick` is an ordinary action with no model call.
import { action, t } from "../patchy/_generated/server.js";

/** One model call, then `writes` table inserts: how long each part took, as the guest saw it. */
export const model = action({
  args: {
    kind: t.enum(["generate", "decide"]),
    /** How long the fake takes to answer, unless `at` is set. */
    delayMs: t.integer(),
    /** When the fake answers, in epoch milliseconds (past an integer's range); 0 for none. */
    at: t.number(),
    writes: t.integer()
  },
  result: t.object({ callMs: t.integer(), workMs: t.integer() }),
  handler: async (ctx, { kind, delayMs, at, writes }) => {
    const marker = at > 0 ? `[at=${Math.round(at)}]` : `[delay=${delayMs}]`;
    const started = Date.now();
    if (kind === "decide")
      await ctx.connections.scorer.decide({
        input: `Score this request ${marker}`,
        questions: { spam: { type: "yesNo", instructions: "This is spam" } }
      });
    else
      await ctx.connections.loader.generate({
        input: `Write a reply ${marker}`,
        maxOutputTokens: 600
      });
    const answered = Date.now();
    for (let index = 0; index < writes; index++)
      await ctx.tables.loadRuns.insert({ by: ctx.viewer.user.name, note: `write ${index}` });
    return { callMs: answered - started, workMs: Date.now() - answered };
  }
});

/** An ordinary action: one read, no model call. */
export const quick = action({
  args: {},
  result: t.object({ rows: t.integer() }),
  handler: async (ctx) => ({ rows: (await ctx.tables.loadRuns.list({ limit: 1 })).rows.length })
});
