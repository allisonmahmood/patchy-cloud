// The support inbox, read and answered on the server: each action reaches it through
// ctx.connections.support as the person viewing, and returns only what the page shows.
import { action, t } from "../patchy/_generated/server.js";
import type { Message, Sent, Thread } from "../patchy/_generated/uses/support.js";

const party = t.object({ email: t.text(), name: t.nullable(t.text()) });
const status = t.enum(["open", "waiting", "resolved", "human_review"]);
const label = t.object({ id: t.text(), name: t.text(), colour: t.text() });
const firewall = t.nullable(
  t.object({ verdict: t.enum(["clean", "suspicious"]), kinds: t.array(t.text()) })
);
const thread = t.object({
  id: t.text(),
  subject: t.nullable(t.text()),
  status,
  labels: t.array(label),
  messageCount: t.number(),
  unreadCount: t.number(),
  lastMessageAt: t.nullable(t.text())
});
const message = t.object({
  id: t.text(),
  from: party,
  to: t.array(party),
  createdAt: t.text(),
  held: t.boolean(),
  text: t.text(),
  firewall,
  attachments: t.array(
    t.object({ id: t.text(), filename: t.text(), contentType: t.text(), size: t.number() })
  )
});
/** What became of one email: `held` waits for a member of the Pidgeon account to approve it. */
const sent = t.object({ status: t.enum(["sent", "held"]), threadId: t.text() });

const toParty = ({ email, name }: { readonly email: string; readonly name: string | null }) => ({
  email,
  name
});
const toThread = (found: Thread) => ({
  id: found.id,
  subject: found.subject,
  status: found.status,
  labels: found.labels.map(({ id, name, colour }) => ({ id, name, colour })),
  messageCount: found.messageCount,
  unreadCount: found.unreadCount,
  lastMessageAt: found.lastMessageAt
});
const toMessage = (found: Message) => ({
  id: found.id,
  from: toParty(found.from),
  to: found.to.map(toParty),
  createdAt: found.createdAt,
  held: found.held,
  text: found.text,
  firewall:
    found.firewall === null
      ? null
      : { verdict: found.firewall.verdict, kinds: [...found.firewall.kinds] },
  attachments: found.attachments.map(({ id, filename, contentType, size }) => ({
    id,
    filename,
    contentType,
    size
  }))
});
const toSent = (answer: Sent) => ({ status: answer.status, threadId: answer.threadId });

/** The inbox's latest conversations, newest first. */
export const inbox = action({
  readOnly: true,
  args: {},
  result: t.array(thread),
  handler: async (ctx) =>
    (await ctx.connections.support.threads.list({ limit: 100 })).threads.map(toThread)
});

/** Messages matching the words, newest first. */
export const search = action({
  readOnly: true,
  args: { text: t.text() },
  result: t.array(
    t.object({
      messageId: t.text(),
      threadId: t.text(),
      from: party,
      to: t.array(t.text()),
      subject: t.nullable(t.text()),
      preview: t.nullable(t.text()),
      held: t.boolean(),
      createdAt: t.text()
    })
  ),
  handler: async (ctx, args) =>
    (await ctx.connections.support.messages.search({ text: args.text, limit: 25 })).hits.map(
      (hit) => ({
        messageId: hit.messageId,
        threadId: hit.threadId,
        from: toParty(hit.from),
        to: [...hit.to],
        subject: hit.subject,
        preview: hit.preview,
        held: hit.held,
        createdAt: hit.createdAt
      })
    )
});

/** One conversation's every message, page by page, with its labels. */
export const conversation = action({
  readOnly: true,
  args: { id: t.text() },
  result: t.object({
    thread: t.object({ id: t.text(), subject: t.nullable(t.text()), status }),
    labels: t.array(label),
    messages: t.array(message)
  }),
  handler: async (ctx, args) => {
    const support = ctx.connections.support;
    const first = await support.threads.get(args.id);
    const messages = [...first.messages];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await support.threads.get(args.id, { cursor });
      messages.push(...next.messages);
      cursor = next.nextCursor;
    }
    return {
      thread: { id: first.thread.id, subject: first.thread.subject, status: first.thread.status },
      labels: first.labels.map(({ id, name, colour }) => ({ id, name, colour })),
      messages: messages.map(toMessage)
    };
  }
});

/** Every label the inbox has. */
export const labels = action({
  readOnly: true,
  args: {},
  result: t.array(label),
  handler: async (ctx) =>
    (await ctx.connections.support.labels.list()).map(({ id, name, colour }) => ({
      id,
      name,
      colour
    }))
});

/** Moves a conversation to a status everyone reading the inbox shares. */
export const setStatus = action({
  args: { id: t.text(), status },
  result: status,
  handler: async (ctx, args) =>
    (await ctx.connections.support.threads.update(args.id, { status: args.status })).status
});

/** Applies or removes one label on a conversation. */
export const relabel = action({
  args: { id: t.text(), labelId: t.text(), applied: t.boolean() },
  result: t.boolean(),
  handler: async (ctx, args) => {
    const support = ctx.connections.support;
    if (args.applied) await support.threads.label(args.id, args.labelId);
    else await support.threads.unlabel(args.id, args.labelId);
    return args.applied;
  }
});

/** Answers a message in its thread; the draft key makes a retry one email. */
export const reply = action({
  args: { id: t.text(), text: t.text(), idempotencyKey: t.text() },
  result: sent,
  handler: async (ctx, args) =>
    toSent(
      await ctx.connections.support.messages.reply(args.id, {
        text: args.text,
        idempotencyKey: args.idempotencyKey
      })
    )
});

/** Starts a conversation from the inbox; the draft key makes a retry one email. */
export const send = action({
  args: {
    to: t.array(t.text()),
    subject: t.text(),
    text: t.text(),
    idempotencyKey: t.text()
  },
  result: sent,
  handler: async (ctx, args) =>
    toSent(
      await ctx.connections.support.messages.send({
        to: args.to,
        subject: args.subject,
        text: args.text,
        idempotencyKey: args.idempotencyKey
      })
    )
});
