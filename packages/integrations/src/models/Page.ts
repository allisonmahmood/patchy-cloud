import type { ModelsSnapshot } from "@patchy/api";
import * as Redacted from "effect/Redacted";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as ConnectionStore from "../ConnectionStore.js";
import type * as View from "../ConnectionsView.js";

/**
 * What the connections pages say about a model provider connection (`openai`) and a model role
 * (`models`). PROTOTYPE: neither has a connect or settings flow yet; the `models` scenario seeds
 * them, and every form here refuses.
 */

type Provider = Extract<ConnectionStore.Connection, { readonly integration: "openai" }>;
type Role = Extract<ConnectionStore.Connection, { readonly integration: "models" }>;

const unbuilt: View.Notice = {
  message: "Connecting this from a page isn't built yet.",
  code: "invalid_credentials",
  status: 422
};
const connectSpec = (reads: string): ConnectFrame.ConnectSpec => ({
  paste: { title: "Not built yet", fields: [] },
  name: { example: "main", describe: reads },
  once: { reads, devReads: false, cannot: ["Patches never see the key"] }
});
const common = {
  actions: { refresh: "Refresh", rotate: "Replace key" },
  credentialRefusals: new Map<string, View.Field>(),
  credentials: (): Redacted.Redacted<string> | View.Notice => unbuilt,
  logged:
    "Each call keeps its patch, operation, duration and outcome; its model and token counts go to Patchy's own events. The input and the answer are never logged."
};

export const OpenAi = {
  ...common,
  integration: { key: "openai", label: "OpenAI", mark: { logo: "openai" } } as const,
  offer: {
    integration: { key: "openai", label: "OpenAI", mark: { logo: "openai" } } as const,
    line: "Models for the company's roles"
  },
  connect: connectSpec("the models the company's roles map to")
};
export const openAiSource = (connection: Provider) => `key ${connection.display.keyHint}`;
export const openAiFacts = (connection: Provider): ReadonlyArray<readonly [string, string]> => [
  ["Key", connection.display.keyHint]
];
export const openAiCredential = (connection: Provider) => ({
  label: "API key",
  detail: `Stored · ${connection.display.keyHint}`
});

export const Models = {
  ...common,
  integration: { key: "models", label: "Model role", mark: "AI" } as const,
  offer: {
    integration: { key: "models", label: "Model role", mark: "AI" } as const,
    line: "A model patches ask for by role"
  },
  connect: connectSpec("a role patches ask a model for")
};
export const roleSource = (connection: Role) =>
  `${connection.display.kind} role, ${connection.display.model}`;
export const roleFacts = (connection: Role): ReadonlyArray<readonly [string, string]> => [
  ["Kind", connection.display.kind],
  ["Model", connection.display.model],
  ["Provider connection", connection.display.provider]
];
export const roleCredential = () => ({
  label: "Credentials",
  detail: "None: its provider connection holds the key"
});
export const roleReads = (snapshot: ModelsSnapshot) => ({
  summary:
    snapshot.kind === "decision"
      ? "Answers fixed questions with probabilities: decide."
      : "Writes text or a typed value: generate.",
  items: [],
  more: 0
});
