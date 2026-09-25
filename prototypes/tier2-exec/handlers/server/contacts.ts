// PROTOTYPE for #311: the contacts module as an agent would write it.
import { t } from "../patchy.ts";

declare const PATCH_VERSION: string;

// No callbacks at all: the pure host->exec->host round trip.
export const ping = t.query({
  handler: async () => ({ pong: true, version: PATCH_VERSION })
});

// One callback.
export const list = t.query({
  handler: async (ctx) => ctx.tables.list("contacts")
});

// Awaits a host-side delay; used to hold many invocations in flight.
export const slow = t.query<{ ms: number }>({
  handler: async (ctx, { ms }) => {
    await ctx.run.sleep(ms);
    return { slept: ms };
  }
});

// TEN callbacks under one transaction: 5 inserts, 1 read, 4 updates that
// branch on what the read returned.
export const createMany = t.mutation<{ prefix: string }>({
  handler: async (ctx, { prefix }) => {
    const inserted = [];
    for (let i = 0; i < 5; i++) {
      inserted.push(
        await ctx.tables.insert("contacts", {
          name: `${prefix}-${i}`,
          email: `${prefix}-${i}@example.com`
        })
      );
    }
    const seen = await ctx.tables.list("contacts", { name_like: `${prefix}-%` });
    const domain = seen.length >= 5 ? "many.example.com" : "few.example.com";
    for (let i = 0; i < 4; i++) {
      await ctx.tables.update(
        "contacts",
        { id: inserted[i].id },
        { email: `${prefix}-${i}@${domain}` }
      );
    }
    return { inserted: inserted.length, seen: seen.length, domain };
  }
});

// Several callbacks, then throw: everything must roll back.
export const createThenFail = t.mutation<{ prefix: string }>({
  handler: async (ctx, { prefix }) => {
    for (let i = 0; i < 3; i++) {
      await ctx.tables.insert("contacts", {
        name: `${prefix}-fail-${i}`,
        email: `${prefix}-fail-${i}@example.com`
      });
    }
    throw new Error("createThenFail: deliberate failure after 3 inserts");
  }
});

// Read-then-write on one counter row: the contention case.
export const bump = t.mutation<{ name: string }>({
  handler: async (ctx, { name }) => {
    const [row] = await ctx.tables.list("counters", { name });
    const next = (row?.value ?? 0) + 1;
    await ctx.tables.update("counters", { name }, { value: next });
    return { value: next };
  }
});

// Same as bump with a host-side pause between the read and the write, so two
// concurrent writers reliably overlap and one of them hits 40001.
export const bumpSlow = t.mutation<{ name: string; ms: number }>({
  handler: async (ctx, { name, ms }) => {
    const [row] = await ctx.tables.list("counters", { name });
    await ctx.run.sleep(ms);
    const next = (row?.value ?? 0) + 1;
    await ctx.tables.update("counters", { name }, { value: next });
    return { value: next };
  }
});
