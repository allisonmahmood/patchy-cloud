// PROTOTYPE for #314: the server function contract (#296), the `patchy/server` entry.
//
// A tier 2 patch's `server/*.ts` files export handlers built here. A handler is one of three
// kinds and is named `<file>.<export>` on the wire. `patchy/_generated/server.ts` re-exports the
// builders bound to the config's table types (`bind<typeof config>()`), so `ctx.tables.notes` is
// typed without a generic. Enforcement is the host's: the wire validates `args` before the
// handler runs and `result` after it; a query's writes are refused by the callback host, not
// only by these types. Skipped in this slice: `ctx.shared`, `ctx.files`, `ctx.connections`,
// `ctx.run` and the mutation key.
import type { Config, FieldDescriptor, Infer, Json, Row } from "./config.js";
import type { OwnedTable, ReadTable, TableIndexes } from "./client.js";
export { t } from "./config.js";
export { HandlerError, isHandlerError } from "./handlerError.js";

export type HandlerKind = "query" | "mutation" | "action";

/** Never null on a company version; public tier 2 is not in this slice. */
export interface Viewer {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
  readonly admin: boolean;
}

export type QueryTables<C extends Config> = {
  readonly [N in keyof C["tables"] & string]: ReadTable<Row<C, N>, TableIndexes<C["tables"][N]>>;
};
export type MutationTables<C extends Config> = {
  readonly [N in keyof C["tables"] & string]: OwnedTable<C, N>;
};

/** PROTOTYPE for #314 round 3: what generation resolved from the config's `uses`. */
export interface Uses {
  readonly shared: Readonly<Record<string, unknown>>;
  readonly connections: Readonly<Record<string, unknown>>;
}
export type NoUses = {
  readonly shared: Record<never, never>;
  readonly connections: Record<never, never>;
};

/** A sibling handler run from an action; typed loosely, the manifest validates at the wire. */
export type Run = {
  readonly [module: string]: {
    readonly [handler: string]: (args?: Readonly<Record<string, Json>>) => Promise<unknown>;
  };
};

/**
 * One context shape, narrowed per kind (#296 point 4): a query's tables are read-only and it
 * may read shared tables; a mutation reaches only its own tables; an action also reaches
 * declared connections and runs sibling handlers. The host refuses what the types hide.
 */
export interface Context<C extends Config, Kind extends HandlerKind, U extends Uses = NoUses> {
  readonly viewer: Viewer;
  readonly tables: Kind extends "query" ? QueryTables<C> : MutationTables<C>;
  readonly shared: Kind extends "mutation" ? Record<never, never> : U["shared"];
  readonly connections: Kind extends "action" ? U["connections"] : Record<never, never>;
  readonly run: Kind extends "action" ? Run : Record<never, never>;
  /** Appends to the invocation's runtime log entry; `patchy dev logs` prints it locally. */
  readonly log: (message: string, details?: Json) => void;
}

/** `args` is always an object descriptor; both constraints are structural, never the classes. */
export type ArgsDescriptor = FieldDescriptor & { readonly descriptor: "object" };

export interface Handler<
  Kind extends HandlerKind = HandlerKind,
  Args extends ArgsDescriptor = ArgsDescriptor,
  Result extends FieldDescriptor = FieldDescriptor,
  Errors extends string = string,
  C extends Config = Config,
  U extends Uses = Uses
> {
  readonly __patchy: "handler";
  readonly kind: Kind;
  readonly args: Args;
  readonly result: Result;
  readonly errors: readonly Errors[];
  readonly handler: (ctx: Context<C, Kind, U>, args: Infer<Args, C>) => Promise<Infer<Result, C>>;
}

export interface Declaration<
  Kind extends HandlerKind,
  Args extends ArgsDescriptor,
  Result extends FieldDescriptor,
  Errors extends string,
  C extends Config,
  U extends Uses = NoUses
> {
  readonly args: Args;
  readonly result: Result;
  readonly errors?: readonly Errors[];
  readonly handler: (ctx: Context<C, Kind, U>, args: Infer<Args, C>) => Promise<Infer<Result, C>>;
}

const declare =
  <C extends Config, U extends Uses, Kind extends HandlerKind>(kind: Kind) =>
  <Args extends ArgsDescriptor, Result extends FieldDescriptor, Errors extends string = never>(
    definition: Declaration<Kind, Args, Result, Errors, C, U>
  ): Handler<Kind, Args, Result, Errors, C, U> => {
    if (definition.args === undefined || definition.result === undefined)
      throw new Error(`A ${kind} declares both args and result.`);
    return {
      __patchy: "handler",
      kind,
      args: definition.args,
      result: definition.result,
      errors: definition.errors ?? [],
      handler: definition.handler
    };
  };

/**
 * The builders bound to a config type and to what generation resolved from `uses`; generation
 * emits this call in `_generated/server.ts` together with the client factories the guest entry
 * uses to build `ctx.shared` and `ctx.connections` over the callback stub.
 */
export const bind = <C extends Config, U extends Uses = NoUses>() => ({
  query: declare<C, U, "query">("query"),
  mutation: declare<C, U, "mutation">("mutation"),
  action: declare<C, U, "action">("action")
});

export const { query, mutation, action } = bind<Config>();

export const isHandler = (value: unknown): value is Handler =>
  value !== null &&
  typeof value === "object" &&
  (value as { __patchy?: unknown }).__patchy === "handler" &&
  typeof (value as { handler?: unknown }).handler === "function";

/**
 * What the generated client exposes for a module's handlers, typed from the module itself. The
 * config type is passed in, never inferred back out of `Context<C, Kind>`: that inference walks
 * the whole table-client surface and is excessively deep for the checker.
 */
export type ServerModuleClient<M, C extends Config> = {
  readonly [
    K in keyof M as M[K] extends { readonly __patchy: "handler" } ? K : never
  ]: M[K] extends {
    readonly args: infer Args;
    readonly result: infer Result;
  }
    ? (args: Infer<Args, C>) => Promise<Infer<Result, C>>
    : never;
};
export type ServerClient<Modules, C extends Config> = {
  readonly [M in keyof Modules]: ServerModuleClient<Modules[M], C>;
};
