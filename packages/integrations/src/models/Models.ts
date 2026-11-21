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
 * The host's Models switch, `PATCHY_MODELS`, off unless set. Off, the store reads and makes no
 * role or provider, as a release before Models, and discovery offers and answers none.
 */
export const enabled = Config.Boolean("PATCHY_MODELS").pipe(Config.withDefault(false));

/** Every model provider this release can keep a key for; one integration literal each. */
export const providers = ["openai"] as const;
export const Provider = Schema.Literals(providers);
export type Provider = typeof Provider.Type;

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
