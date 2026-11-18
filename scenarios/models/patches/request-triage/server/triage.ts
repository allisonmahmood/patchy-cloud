// Triage runs on the server: a decision role routes the request and a text role drafts the reply,
// both through ctx.connections, then a row records what they said. The failure modes call roles
// an admin mapped to models that fail, and let each refusal reach the page as Patchy sent it.
import { action, query, t } from "../patchy/_generated/server.js";

const triaged = t.object({
  id: t.text(),
  team: t.text(),
  urgency: t.text(),
  urgencyScore: t.number(),
  spam: t.number(),
  reply: t.text(),
  usage: t.object({
    decideTokens: t.nullable(t.integer()),
    generateTokens: t.nullable(t.integer())
  })
});

/** Routes a pasted request, scores it, drafts a reply and keeps all three. */
export const run = action({
  args: { subject: t.text(), body: t.text() },
  result: triaged,
  handler: async (ctx, { subject, body }) => {
    const { answers, usage } = await ctx.connections.triage.decide({
      input: { subject, body },
      questions: {
        team: {
          type: "choice",
          instructions: "Which team should handle this request?",
          options: {
            billing: "Invoices, payments, refunds",
            it: "Laptops, accounts, access",
            facilities: "Desks, rooms, building access"
          }
        },
        urgency: {
          type: "scale",
          instructions: "How urgent is it?",
          levels: ["can wait", "this week", "today"]
        },
        spam: { type: "yesNo", instructions: "This is spam or a sales pitch" }
      }
    });
    // A refused question answers null: the types make the handler choose what that means.
    const team = answers.team?.choice ?? "unrouted";
    const urgency = answers.urgency?.level ?? "unknown";
    const spam = answers.spam?.probability ?? 0;
    const { value: draft, usage: written } = await ctx.connections.writer.generate({
      instructions:
        "Draft a short, formal reply to this internal request, from the team that will handle it. Two or three sentences; promise nothing beyond following up.",
      input: { subject, body, team, urgency },
      maxOutputTokens: 600,
      output: t.object({
        reply: t.text().describe("The reply, ready to send"),
        tone: t.enum(["formal", "neutral"])
      })
    });
    const row = await ctx.tables.requests.insert({
      subject,
      body,
      team,
      urgency,
      spam,
      reply: draft.reply,
      by: ctx.viewer.user.name
    });
    return {
      id: row.id,
      team,
      urgency,
      urgencyScore: answers.urgency?.score ?? 0,
      spam,
      reply: draft.reply,
      usage: { decideTokens: usage.inputTokens, generateTokens: written.outputTokens }
    };
  }
});

/** The latest triaged requests. */
export const recent = query({
  args: {},
  result: t.array(t.row("requests")),
  handler: async (ctx) => (await ctx.tables.requests.list({ limit: 20 })).rows
});

const modes = [
  "thinker",
  "stuck",
  "limited",
  "refuser",
  "picky",
  "sloppy",
  "rambler",
  "bouncer",
  "offline",
  "wrongKind",
  "badOutput"
] as const;

/**
 * One model failure on purpose. Refusals aren't caught here, so the page receives each exactly
 * as Patchy sent it; `elapsedMs` says how long the call took when it didn't throw.
 */
export const failure = action({
  args: { mode: t.enum(modes) },
  result: t.object({ mode: t.text(), elapsedMs: t.integer(), outcome: t.text() }),
  handler: async (ctx, { mode }) => {
    const started = Date.now();
    const input = {
      subject: "Laptop won't boot",
      body: "My laptop shows a black screen since this morning. I need it today."
    };
    const write = (
      role: "thinker" | "stuck" | "limited" | "refuser" | "offline" | "rambler" | "bouncer"
    ) =>
      ctx.connections[role].generate({
        instructions: "Draft a formal reply.",
        input,
        maxOutputTokens: 300
      });
    let outcome: string;
    switch (mode) {
      case "thinker":
      case "stuck":
      case "limited":
      case "refuser":
      case "offline":
      case "rambler":
      case "bouncer":
        outcome = (await write(mode)).text.slice(0, 80);
        break;
      case "picky": {
        const { answers } = await ctx.connections.picky.decide({
          input,
          questions: {
            team: {
              type: "choice",
              instructions: "Which team?",
              options: { it: "IT", billing: "Billing" }
            },
            spam: { type: "yesNo", instructions: "This is spam" }
          }
        });
        outcome = `team=${answers.team?.choice ?? "null"} spam=${answers.spam === null ? "null (refused)" : answers.spam.probability}`;
        break;
      }
      case "sloppy": {
        const { value } = await ctx.connections.sloppy.generate({
          input,
          maxOutputTokens: 300,
          output: t.object({ reply: t.text(), tone: t.enum(["formal", "neutral"]) })
        });
        outcome = value.reply;
        break;
      }
      case "wrongKind": {
        // Forced past the types: a text role has no decide.
        const forced = ctx.connections.writer as unknown as typeof ctx.connections.triage;
        const { answers } = await forced.decide({
          input,
          questions: { spam: { type: "yesNo", instructions: "This is spam" } }
        });
        outcome = JSON.stringify(answers);
        break;
      }
      case "badOutput": {
        // Forced past the types: optional fields aren't in a typed output's subset.
        const { value } = await ctx.connections.writer.generate({
          input,
          maxOutputTokens: 300,
          output: t.object({ reply: t.text().optional() }) as never
        });
        outcome = JSON.stringify(value);
        break;
      }
    }
    return { mode, elapsedMs: Date.now() - started, outcome };
  }
});
