/**
 * Models: a patch's action asks a company's model role, and the role is mapped by an admin to a
 * provider, the company's key for one model provider, and a model id there. Roles are connections
 * of the public `models` integration. Providers are connections the store keeps under their own
 * integrations, never offered to a builder, declared by a patch or read as a `Connection`.
 */
import { type Integration, integrations } from "@patchy/api";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

/**
 * The host's Models switch, `PATCHY_MODELS`: `true` is on; `false`, unset or empty is off, as a
 * host secret holds an unused setting; anything else stops the launch. Off, the store reads and
 * makes no role or provider, as a release before Models, and discovery offers and answers none.
 */
export const enabled = Config.Literals(["true", "false", ""], "PATCHY_MODELS").pipe(
  Config.withDefault(""),
  Config.map((value) => value === "true")
);

/** Every model provider this release can keep a key for; one integration literal each. */
export const providers = ["openai"] as const;
export const Provider = Schema.Literals(providers);
export type Provider = typeof Provider.Type;

/**
 * What each provider can serve, by role kind, from its own documentation: the endpoint a call
 * goes to and the models its documentation says can serve it. A provider and kind missing here
 * can't serve a role. Each row names the page it was read from.
 */
export const capabilities = {
  openai: {
    decision: {
      endpoint: "POST https://api.openai.com/v1/decisions",
      credentials: "API key, as a bearer token",
      models: "gpt-6-luna, the only model OpenAI says the Decisions API supports",
      documentation:
        "https://developers.openai.com/api/reference/resources/decisions/methods/create/"
    },
    text: {
      endpoint: "POST https://api.openai.com/v1/responses",
      credentials: "API key, as a bearer token",
      models: "a model id the Responses API accepts; max_output_tokens is at least 16",
      documentation:
        "https://developers.openai.com/api/reference/resources/responses/methods/create/"
    }
  }
} as const satisfies {
  readonly [P in Provider]: {
    readonly [K in "decision" | "text"]?: {
      readonly endpoint: string;
      readonly credentials: string;
      readonly models: string;
      readonly documentation: string;
    };
  };
};

/** Every kind of connection the store keeps: the public integrations and the providers. */
export type Kind = Integration | Provider;

/** What this release's store knows, by its Models switch. */
export const known = (on: boolean): ReadonlyArray<Kind> =>
  on ? [...integrations, ...providers] : integrations.filter((kind) => kind !== "models");

/**
 * A model id as its provider names it, such as `gpt-5-mini`, `openai/gpt-5-mini` on a router or
 * an inference profile's ARN: no spaces, at most 200 characters.
 */
export const ModelId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/)
);
export const isModelId = Schema.is(ModelId);
