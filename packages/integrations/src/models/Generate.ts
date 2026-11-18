import type { ModelsDeclaration, ModelsSnapshot } from "@patchy/api";

/**
 * What generation writes for a model role: a client typed by the role's kind, so a decision role
 * offers only `decide` and a text role only `generate`, and its context. The model behind the role
 * isn't named: an admin can change it without the patch changing. PROTOTYPE.
 */
export interface Generated {
  readonly client: string;
  readonly context: string;
}

const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "&#96;").replaceAll("\n", " ").replaceAll("|", "&#124;")}</code>`;

const client = (decision: boolean) => {
  const role = decision ? "DecisionRole" : "TextRole";
  return `// Generated from a model role's snapshot. Tier 2 actions type ctx.connections with it; the host supplies the transport.
// Patchy holds the provider's key and picks the model the role maps to now; this client names neither.
import { createModelsClient } from "patchy/client";
import type { Call, Errors, BoundaryError as ClientBoundaryError, ${role} } from "patchy/client";
export type { ModelQuestion as Question, ModelAnswer as Answer, ModelUsage as Usage${decision ? "" : ", ModelOutputSchema as OutputSchema"} } from "patchy/client";
export type BoundaryError = ClientBoundaryError | Errors<"connection_not_declared">;
// These unions describe known Patchy refusals, not checked or exhaustive TypeScript throws.
export type CallError = BoundaryError | Errors<"source_rate_limited"${decision ? "" : ' | "output_truncated" | "model_refused" | "shape_mismatch"'}, "models.${decision ? "decide" : "generate"}">;
export type Client = ${role};
export function createClient(connection: string, call: Call): Client {
  return createModelsClient(connection, call);
}
`;
};

const decideDoc = `## decide

\`ctx.connections.<alias>.decide({ input, questions })\`, in an action. \`input\` is a string or JSON. \`questions\` holds one to 20 questions by a name of your own, each one of:

- \`{ type: "choice", instructions, options: { key: "what it means", ... } }\`: 2 to 50 options. Its answer is \`{ choice, probabilities }\`: the likeliest option's key and each option's probability.
- \`{ type: "scale", instructions, levels: ["lowest", ..., "highest"] }\`: 2 to 10 levels. Its answer is \`{ level, score, probabilities }\`: the likeliest level, the probability-weighted level from 0 to the number of levels less one, and each level's probability.
- \`{ type: "yesNo", instructions }\`: instructions state something that is true or not. Its answer is \`{ probability }\`, from 0 to 1.

Each answer is \`null\` when the model refused that question; the other answers still come back. A decision role writes no text.`;

const generateDoc = `## generate

\`ctx.connections.<alias>.generate({ instructions, input, maxOutputTokens })\`, in an action, answers \`{ text, usage }\`. \`input\` is a string or JSON. \`maxOutputTokens\` is required, at most 16,000: a model that reaches it fails \`output_truncated\` and returns nothing.

With \`output\`, a \`t.object({...})\` from \`patchy/server\`, it answers \`{ value, usage }\`, \`value\` typed by the object: Patchy asks the model for that shape and checks its answer before returning it, failing \`shape_mismatch\` when it doesn't match. Every field is required; fields are \`t.text()\`, \`t.integer()\`, \`t.number()\`, \`t.boolean()\`, \`t.enum([...])\`, \`t.array(...)\` and \`t.object({...})\` of those, and \`.describe("...")\` tells the model what a field holds. Anything else is refused \`invalid_request\` before the model is asked.

\`model_refused\`: the model declined.`;

/** The role as an agent building with it needs it. */
export const generate = (
  declaration: typeof ModelsDeclaration.Type & { readonly description?: string },
  snapshot: ModelsSnapshot
): Generated => {
  const decision = snapshot.kind === "decision";
  return {
    client: client(decision),
    context: `# Model role

Handle: ${markdown(declaration.handle)}

Description: ${markdown(declaration.description ?? "")}

Kind: ${decision ? "decision. Its client has `decide` only" : "text. Its client has `generate` only"}.

A role is the company's: an admin maps it to a model on a provider the company connected with its own key, and can change the model without this patch changing. Patch code never sees the key or the model. Only actions call it; a query, a mutation or a page can't.

${decision ? decideDoc : generateDoc}

## Every call

- Patchy makes one request to the provider per call and never retries it.
- A call may use what's left of its action's 60 seconds, less one second Patchy keeps so the handler hears why it stopped: past that it fails \`timeout\` and the request is cancelled.
- \`busy\`: Patchy's limits on the company's calls to the provider were full (4 running and 4 waiting per person), so nothing was sent. \`source_rate_limited\`: the provider is refusing for its rate (\`details.limit\` \`"requests"\`, with \`retryAfter\` when it said) or the company's quota (\`"quota"\`). \`source_unavailable\`: it couldn't be reached, refused the company's key or failed. \`access_denied\`: the role is paused or gone, or the patch's owner can't build with it.
- An action that doesn't catch a refusal fails with it, and the page's call receives the same \`code\` and \`details\`, with \`operation\` \`models.${decision ? "decide" : "generate"}\`.
- \`usage\` is what the provider counted, \`null\` where it didn't say. Patchy's logs keep the role, the model, the duration and the token counts, never the input or the answer.
- In \`patchy dev\` calls are real, as you, on the company's provider, and count against your 200 model calls per UTC day in dev; past them they fail \`rate_limited\` with \`limitId\` \`models.dev.calls.daily\`. Published patches aren't counted.

Read \`.agents/skills/patchy-models/SKILL.md\` before building with it.
`
  };
};
