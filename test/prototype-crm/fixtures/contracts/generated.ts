// PROTOTYPE for #315: what `patchy refresh` generates as patchy/_generated/server.ts, by hand.
import { bind } from "patchy/server";
import type { Config } from "patchy/config";
export const uses = { shared: {}, connections: {} };
type Contracts = Config & {
  readonly files: { readonly documents: { readonly description: string } };
  readonly tables: Record<never, never>;
};
export const { query, mutation, action } = bind<
  Contracts,
  { readonly shared: Record<never, never>; readonly connections: Record<never, never> }
>();
export { t, HandlerError, isHandlerError } from "patchy/server";
