// Request triage asks the company's two model roles about one pasted request, in one action, as
// the person viewing: the decision role picks a team and rates the urgency with probabilities, and
// the text role writes a line about the request and a reply plan of a fixed shape. A refusal is
// left to reach the page with its code.
import { action, t } from "../patchy/_generated/server.js";

const teams = ["billing", "technical", "sales"] as const;
const plan = t.object({
  team: t.enum(teams),
  reply: t.text(),
  followUp: t.boolean()
});

export const run = action({
  args: { request: t.text() },
  result: t.object({
    team: t.nullable(t.object({ choice: t.text(), probability: t.number() })),
    urgency: t.nullable(t.object({ level: t.text(), score: t.number() })),
    spam: t.nullable(t.number()),
    summary: t.text(),
    plan
  }),
  handler: async (ctx, args) => {
    const [decided, summary, planned] = await Promise.all([
      ctx.connections.triage.decide({
        input: args.request,
        questions: {
          team: {
            type: "choice",
            instructions: "Which team should handle this request?",
            options: {
              billing: "Charges, refunds and invoices",
              technical: "Bugs, outages and errors",
              sales: "Pricing, plans and new accounts"
            }
          },
          urgency: {
            type: "scale",
            instructions: "How urgent is this request?",
            levels: ["low", "medium", "high"]
          },
          spam: { type: "yesNo", instructions: "This request is spam or a sales pitch." }
        }
      }),
      ctx.connections.writer.generate({
        instructions: "Say in one line what this support request is about.",
        input: args.request,
        maxOutputTokens: 60
      }),
      ctx.connections.writer.generate({
        instructions: "Plan the reply to this support request.",
        input: args.request,
        maxOutputTokens: 200,
        output: plan
      })
    ]);
    const { team, urgency, spam } = decided.answers;
    return {
      team:
        team !== null && team !== undefined && "choice" in team
          ? { choice: team.choice, probability: team.probabilities[team.choice] ?? 0 }
          : null,
      urgency:
        urgency !== null && urgency !== undefined && "level" in urgency
          ? { level: urgency.level, score: urgency.score }
          : null,
      spam: spam !== null && spam !== undefined && "probability" in spam ? spam.probability : null,
      summary: summary.text,
      plan: planned.value
    };
  }
});
