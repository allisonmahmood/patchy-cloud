// PROTOTYPE load test: actions the slot driver calls. `model` makes one model call whose fake
// answer time the caller picks (the fake reads the marker in its input), then a little table
// work; `dual` makes a second model call while its first is still in flight; `hold` occupies an
// action slot for a while with no model call; `quick` is an ordinary action with no model call.
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

/**
 * Two model calls in flight at once: a decide, then `secondAfterMs` later a generate, awaited
 * together. When each answered, in ms after the action began.
 */
export const dual = action({
  args: { firstDelayMs: t.integer(), secondAfterMs: t.integer(), secondDelayMs: t.integer() },
  result: t.object({ firstMs: t.integer(), secondMs: t.integer() }),
  handler: async (ctx, { firstDelayMs, secondAfterMs, secondDelayMs }) => {
    const started = Date.now();
    const first = ctx.connections.scorer
      .decide({
        input: `First call [delay=${firstDelayMs}]`,
        questions: { spam: { type: "yesNo", instructions: "This is spam" } }
      })
      .then(() => Date.now() - started);
    await new Promise((resolve) => setTimeout(resolve, secondAfterMs));
    const second = ctx.connections.loader
      .generate({ input: `Second call [delay=${secondDelayMs}]`, maxOutputTokens: 600 })
      .then(() => Date.now() - started);
    const [firstMs, secondMs] = await Promise.all([first, second]);
    return { firstMs, secondMs };
  }
});

/** Holds an action slot for `ms` with nothing but a timer: an action that is running. */
export const hold = action({
  args: { ms: t.integer() },
  result: t.object({ ms: t.integer() }),
  handler: async (_ctx, { ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ms };
  }
});

/** An ordinary action: one read, no model call. */
export const quick = action({
  args: {},
  result: t.object({ rows: t.integer() }),
  handler: async (ctx) => ({ rows: (await ctx.tables.loadRuns.list({ limit: 1 })).rows.length })
});
