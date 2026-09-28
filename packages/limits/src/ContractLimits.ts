import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { registry, type ContractLimitId } from "./registry.js";

/** Explicit test injection only. Deployment configuration never changes contract limits. */
export const overrides = Context.Reference<Readonly<Partial<Record<ContractLimitId, number>>>>(
  "@patchy/limits/ContractLimits/overrides",
  { defaultValue: () => ({}) }
);

export const get = (id: ContractLimitId): Effect.Effect<number> =>
  Effect.map(overrides, (values) => values[id] ?? registry[id].default);
