import type { ModelRoleKind, ModelsDeclaration, ModelsSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";

/** What generation writes for a model role: the client its kind gives, and its context. */
export interface Generated {
  readonly client: string;
  readonly context: string;
}

const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("`", "&#96;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("|", "&#124;")}</code>`;

// The guest makes each role's client by the kind the build hands it, so these are types alone.
const client = (kind: ModelRoleKind) => {
  const type = kind === "decision" ? "DecisionClient" : "TextClient";
  return `// Generated for a ${kind} model role. Tier 2 actions type ctx.connections with it; the guest makes the client.
// A ${kind} role has ${kind === "decision" ? "decide" : "generate"} alone. Patch code never sees the provider, the model or the key.
import type { BoundaryError as ClientBoundaryError, Errors, ${type} } from "patchy/client";
export type { ErrorCode, ErrorDetails, Errors, ModelAnswer as Answer, ModelQuestion as Question, ModelUsage as Usage } from "patchy/client";
export type BoundaryError = ClientBoundaryError | Errors<"connection_not_declared">;
export type Client = ${type};
`;
};

const calls = {
  decision: `\`decide({ input, questions })\`: 1 to 20 fixed questions about one input, each \`choice\` (2 to 50 options, by name and meaning), \`scale\` (2 to 10 levels, lowest first) or \`yesNo\`. Each answers with probabilities, or \`null\` when the model refused that question.`,
  text: `\`generate({ instructions, input, maxOutputTokens, output })\`: text, or with \`output\`, a value of that \`t.object\` shape. \`maxOutputTokens\` is required, 16 to ${registry["models.generate.maxOutputTokens"].default}.`
} as const;

/** The role as an agent building with it needs it: its kind and its one call. */
export const generate = (
  declaration: typeof ModelsDeclaration.Type & { readonly description?: string },
  snapshot: ModelsSnapshot
): Generated => ({
  client: client(snapshot.kind),
  context: `# Model role

Handle: ${markdown(declaration.handle)}

Description: ${markdown(declaration.description ?? "")}

Snapshot revision: ${declaration.revision}

Kind: ${snapshot.kind}

An admin maps the role to a provider and a model, and can change either at any time; a patch follows from its next call. Patch code never sees the provider, the model or the company's key. Each call sends what the handler passes to that provider.

## Call

Use the declared alias in an action: \`ctx.connections.<alias>\`. Pages, queries and mutations can't call a role.

- ${calls[snapshot.kind]}
- Each call makes one provider request and is never retried. A refusal says in \`details.sent\` whether a request went out; with no \`sent\`, its reply was lost and whether it was charged is unknown.
- An action runs ${registry["models.calls.inFlight"].default} model calls at a time and makes ${registry["models.calls.perAction"].default} in all, across every role it declares; the rest wait in the action. A call stops ${registry["models.cutoff"].default / 1000} second before the action's deadline.
`
});
