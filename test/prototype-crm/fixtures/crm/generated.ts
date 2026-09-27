// PROTOTYPE for #315: what `patchy refresh` generates as patchy/_generated/server.ts, by hand.
import { bind, createSharedStore, type ServerCallback, type SharedStore } from "patchy/server";
import type { Config, Column } from "patchy/config";
export const uses = {
  shared: { contracts: (alias: string, call: ServerCallback) => createSharedStore(alias, call) },
  connections: {}
};
type Crm = Config & {
  readonly tables: {
    readonly deals: {
      readonly description: string;
      readonly columns: {
        readonly title: Column<"text", false, false>;
        readonly stage: Column<"text", false, false>;
        readonly private: Column<"boolean", false, false>;
        readonly ownerId: Column<"text", false, false>;
      };
      readonly indexes: Record<never, never>;
    };
    readonly attachments: {
      readonly description: string;
      readonly columns: {
        readonly dealId: Column<"text", false, false>;
        readonly name: Column<"text", false, false>;
        readonly ownerId: Column<"text", false, false>;
      };
      readonly indexes: { readonly byDeal: { readonly columns: readonly ["dealId"] } };
    };
  };
  readonly files: { readonly dealFiles: { readonly description: string } };
};
export const { query, mutation, action } = bind<
  Crm,
  {
    readonly shared: { readonly contracts: SharedStore };
    readonly connections: Record<never, never>;
  }
>();
export { t, HandlerError, isHandlerError } from "patchy/server";
