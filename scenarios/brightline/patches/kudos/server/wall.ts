// The wall's reads and the two writes people make on it. The sender of a kudos and the member
// behind a reaction are always the person viewing, never an argument.
import type { Id } from "patchy/config";
import { HandlerError, mutation, query, t } from "../patchy/_generated/server.js";
import { EMOJIS, MESSAGE_MAX, VALUE_KEYS } from "../helpers/kudos.js";

/** Newest-first kudos, narrowed to a recipient, a value or both. */
export const wall = query({
  guest: true,
  args: { recipient: t.nullable(t.text()), value: t.nullable(t.text()), limit: t.integer() },
  result: t.object({ rows: t.array(t.row("kudos")), cursor: t.nullable(t.text()) }),
  handler: async (ctx, { recipient, value, limit }) => {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    return recipient !== null && value !== null
      ? ctx.tables.kudos.list({
          index: "byRecipientValue",
          eq: { recipient, value },
          order: "desc",
          limit: bounded
        })
      : recipient !== null
        ? ctx.tables.kudos.list({
            index: "byRecipient",
            eq: { recipient },
            order: "desc",
            limit: bounded
          })
        : value !== null
          ? ctx.tables.kudos.list({
              index: "byValue",
              eq: { value },
              order: "desc",
              limit: bounded
            })
          : ctx.tables.kudos.list({ index: "bySentAt", order: "desc", limit: bounded });
  }
});

/** Every kudos sent since the timestamp, newest first, for the side panel's totals. */
export const recent = query({
  guest: true,
  args: { since: t.text() },
  result: t.array(t.row("kudos")),
  handler: async (ctx, args) =>
    (
      await ctx.tables.kudos.list({
        index: "bySentAt",
        range: { column: "sentAt", gte: args.since },
        order: "desc",
        limit: 1000
      })
    ).rows
});

/** The newest 1,000 reactions: plenty for a studio wall's visible history. */
export const reactions = query({
  guest: true,
  args: {},
  result: t.array(t.row("reactions")),
  handler: async (ctx) => (await ctx.tables.reactions.list({ limit: 1000 })).rows
});

/** Thanks a colleague, as the person viewing. */
export const give = mutation({
  guest: true,
  args: { recipient: t.text(), value: t.enum(VALUE_KEYS), message: t.text() },
  errors: ["self", "not_a_colleague", "invalid_message"],
  result: t.row("kudos"),
  handler: async (ctx, args) => {
    if (args.recipient === ctx.viewer.user.id) throw new HandlerError("self", {});
    const message = args.message.trim();
    if (message === "" || message.length > MESSAGE_MAX)
      throw new HandlerError("invalid_message", { max: MESSAGE_MAX });
    const recipient = await ctx.members.get(args.recipient);
    if (recipient === null || !recipient.active) throw new HandlerError("not_a_colleague", {});
    return ctx.tables.kudos.insert({
      recipient: recipient.id,
      sender: ctx.viewer.user.id,
      message,
      value: args.value,
      sentAt: new Date().toISOString()
    });
  }
});

/** Adds or removes the viewer's reaction; reacting twice, or removing none, changes nothing. */
export const react = mutation({
  guest: true,
  args: { kudos: t.text(), emoji: t.enum(EMOJIS), on: t.boolean() },
  result: t.boolean(),
  handler: async (ctx, args) => {
    const kudos = args.kudos as Id<"kudos">;
    const member = ctx.viewer.user.id;
    const { rows } = await ctx.tables.reactions.list({
      index: "byKudosMemberEmoji",
      eq: { kudos, member, emoji: args.emoji },
      limit: 1
    });
    const mine = rows[0];
    if (args.on && mine === undefined)
      await ctx.tables.reactions.insert({ kudos, member, emoji: args.emoji });
    if (!args.on && mine !== undefined) await ctx.tables.reactions.delete(mine.id);
    return args.on;
  }
});
