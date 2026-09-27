// PROTOTYPE for #314: the server function contract (#296), the `patchy/server` entry.
//
// A tier 2 patch's `server/*.ts` files export handlers built here. A handler is one of three
// kinds and is named `<file>.<export>` on the wire. `patchy/_generated/server.ts` re-exports the
// builders bound to the config's table types (`bind<typeof config>()`), so `ctx.tables.notes` is
// typed without a generic. Enforcement is the host's: the wire validates `args` before the
// handler runs and `result` after it; a query's writes are refused by the callback host, not
// only by these types. Skipped in this slice: `ctx.shared`, `ctx.files`, `ctx.connections`,
// `ctx.run` and the mutation key.
import type { Config, FieldDescriptor, FileHandle, Infer, Json, Row, Upload } from "./config.js";
import type { OwnedTable, ReadTable, TableIndexes } from "./client.js";
export type { FileHandle, Upload } from "./config.js";
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

/**
 * PROTOTYPE for #315: one file as a handler sees it. `handle` is minted for this viewer, patch
 * and loaded version; return it to the page (typed `t.fileHandle()`) so the page can show or
 * download exactly these bytes. Returning it is the selection: the page sees what handlers return.
 */
export interface FileEntry {
  readonly name: string;
  /** Bytes, measured by Patchy. */
  readonly size: number;
  /** As written; a staged upload's type is the page's claim, not proof. */
  readonly contentType: string;
  readonly updatedAt: string;
  readonly handle: FileHandle;
}
export interface FilePage {
  readonly files: readonly FileEntry[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly cursor: string | null;
}
export interface FileListOptions {
  /** Only names starting with this. */
  readonly prefix?: string;
  /** 1–1000, default 100. Names are ordered bytewise ascending. */
  readonly limit?: number;
  readonly cursor?: string;
}
/** A file's entry and its bytes, in an action. */
export interface FileContent {
  readonly entry: FileEntry;
  readonly bytes: Uint8Array;
}
/** A store in a query: metadata only. */
export interface QueryFileStore {
  list(options?: FileListOptions): Promise<FilePage>;
  /** The file's entry, or null when no file has this name. */
  stat(name: string): Promise<FileEntry | null>;
}
/** A store the loaded version defines, in an action. */
export interface ActionFileStore extends QueryFileStore {
  /** The bytes enter the isolate; null when no file has this name. */
  get(name: string): Promise<FileContent | null>;
  /**
   * Points `name` at new bytes and returns the new entry (with its handle). An Upload is adopted
   * once, with no copy; its contentType is used unless you pass one. Plain bytes need
   * `{ contentType }`. Replacing a name makes every older handle for it answer `not_found`.
   */
  put(
    name: string,
    content: Upload | Uint8Array,
    options?: { readonly contentType?: string }
  ): Promise<FileEntry>;
  /** False when no file had this name. Older handles for it answer `not_found`. */
  delete(name: string): Promise<boolean>;
}
/** Another patch's shared store: read-only, re-authorised live on every read. */
export interface SharedStore extends QueryFileStore {
  /** Actions only; the host refuses it in a query. */
  get(name: string): Promise<FileContent | null>;
}
type QueryShared<S> = {
  readonly [K in keyof S]: S[K] extends SharedStore ? QueryFileStore : S[K];
};
export type QueryFiles<C extends Config> = {
  readonly [S in keyof C["files"] & string]: QueryFileStore;
};
export type ActionFiles<C extends Config> = {
  readonly [S in keyof C["files"] & string]: ActionFileStore;
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
  /** PROTOTYPE for #315: list/stat in queries and actions; get, put and delete in actions. */
  readonly files: Kind extends "query"
    ? QueryFiles<C>
    : Kind extends "action"
      ? ActionFiles<C>
      : Record<never, never>;
  readonly shared: Kind extends "mutation"
    ? Record<never, never>
    : Kind extends "query"
      ? QueryShared<U["shared"]>
      : U["shared"];
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
    // PROTOTYPE for #315: the host refuses these too; failing at module init names the handler.
    const has = (value: unknown, fileKind: string): boolean =>
      value !== null &&
      typeof value === "object" &&
      ((value as { kind?: unknown }).kind === fileKind ||
        Object.values(value).some((inner) => has(inner, fileKind)));
    const args = JSON.parse(JSON.stringify(definition.args)) as unknown;
    const result = JSON.parse(JSON.stringify(definition.result)) as unknown;
    if (has(args, "fileHandle"))
      throw new Error("t.fileHandle() is legal in results only, never in arguments.");
    if (has(result, "upload"))
      throw new Error("t.upload() is legal in action arguments only, never in results.");
    if (kind !== "action" && has(args, "upload"))
      throw new Error(`t.upload() is legal in action arguments only; this handler is a ${kind}.`);
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
    readonly kind: infer Kind;
    readonly args: infer Args;
    readonly result: infer Result;
  }
    ? Kind extends "query"
      ? QueryClient<Infer<Args, C>, Infer<Result, C>>
      : (args: Infer<Args, C>) => Promise<Infer<Result, C>>
    : never;
};

/** PROTOTYPE for #314 round 3: where a subscription stands; data is kept through `resyncing`. */
export type SubscriptionStatus =
  | "up-to-date"
  | "resyncing"
  | "stopped"
  // PROTOTYPE for #315: hidden past the grace; resumes with `resyncing` when visible again.
  | "suspended";
export interface SubscribeOptions {
  /** A handler error from a re-run (`HandlerError`) or a refusal that ended it (`PatchyError`). */
  readonly onError?: (error: Error) => void;
  readonly onStatus?: (status: SubscriptionStatus) => void;
}
export type Unsubscribe = () => void;
/**
 * A query on the client: call it once, or subscribe. A subscription re-runs the query as the
 * viewer whenever a commit touches a table its last run read, and delivers the whole result
 * each time it changed; the returned function ends it.
 */
export type QueryClient<A, T> = ((args: A) => Promise<T>) & {
  readonly subscribe: (
    args: A,
    onSnapshot: (value: T) => void,
    options?: SubscribeOptions
  ) => Unsubscribe;
};
export type ServerClient<Modules, C extends Config> = {
  readonly [M in keyof Modules]: ServerModuleClient<Modules[M], C>;
};

// --- PROTOTYPE for #315: the guest-side file clients over the callback stub ------------------

/** The guest entry's callback stub: one host operation, its JSON reply or a thrown refusal. */
export type ServerCallback = (op: string, args: unknown) => Promise<unknown>;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};
const content = (value: unknown): FileContent | null => {
  if (value === null) return null;
  const reply = value as { entry: FileEntry; bytes: string };
  return { entry: reply.entry, bytes: fromBase64(reply.bytes) };
};

/** `ctx.files.<store>`; the host gates each operation by the handler's kind. */
export const createFileStore = (store: string, call: ServerCallback): ActionFileStore => ({
  list: (options = {}) => call("serverFiles.list", { ...options, store }) as Promise<FilePage>,
  stat: (name) => call("serverFiles.stat", { store, name }) as Promise<FileEntry | null>,
  get: async (name) => content(await call("serverFiles.get", { store, name })),
  put: (name, value, options = {}) =>
    (value instanceof Uint8Array
      ? call("serverFiles.put", {
          store,
          name,
          bytes: toBase64(value),
          ...(options.contentType === undefined ? {} : { contentType: options.contentType })
        })
      : call("serverFiles.put", {
          store,
          name,
          upload: value.token,
          ...(options.contentType === undefined ? {} : { contentType: options.contentType })
        })) as Promise<FileEntry>,
  delete: (name) => call("serverFiles.delete", { store, name }) as Promise<boolean>
});

/** `ctx.shared.<alias>` for a declared shared store; generated `uses/<alias>.ts` calls this. */
export const createSharedStore = (alias: string, call: ServerCallback): SharedStore => ({
  list: (options = {}) => call("sharedFiles.list", { ...options, alias }) as Promise<FilePage>,
  stat: (name) => call("sharedFiles.stat", { alias, name }) as Promise<FileEntry | null>,
  get: async (name) => content(await call("sharedFiles.get", { alias, name }))
});
