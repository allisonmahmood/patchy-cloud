import type {
  Config,
  FileHandle,
  Id,
  Indexes,
  Insert,
  Row,
  TableDefinition,
  Update
} from "./config.js";
import type { RuntimeSubscription } from "@patchy/api";
import {
  createPostMessageTransport,
  type Call,
  type Me,
  type Transport
} from "./clientTransport.js";
import { PatchyError } from "./clientError.js";
import { canonicalArgs } from "@patchy/api/canonical-args";
import { createQueryRegistry, type QueryCallable, type QueryRegistry } from "./queryRegistry.js";
import { createDownload, type Download } from "./download.js";
export * from "./clientError.js";
export type { Call, Me, Operation, Route, Transport } from "./clientTransport.js";
export { createServerClient, type ServerOnlyClient } from "./serverClient.js";
export { isHandlerError } from "./handlerError.js";
export type { HandlerErrorGuard, MutationUnknownOutcome } from "./server.js";
export { createQueryRegistry } from "./queryRegistry.js";
export type {
  QueryDriver,
  QueryFrame,
  QuerySnapshot,
  QueryCallable,
  QueryRegistry
} from "./queryRegistry.js";

export interface Page<R> {
  readonly rows: readonly R[];
  readonly cursor: string | null;
}
export interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly admin: boolean;
  readonly active: boolean;
}
export interface MemberListOptions {
  readonly cursor?: string;
}
export interface MemberSearchOptions extends MemberListOptions {
  readonly text: string;
}
export interface Members {
  readonly list: QueryCallable<MemberListOptions | undefined, Page<Member>> &
    (() => Promise<Page<Member>>);
  readonly search: QueryCallable<MemberSearchOptions, Page<Member>> &
    ((text: string, options?: MemberListOptions) => Promise<Page<Member>>);
  readonly get: QueryCallable<string, Member | null>;
  readonly getMany: QueryCallable<readonly string[], readonly (Member | null)[]>;
}
export type DeclaredMembers<C extends Config, Directory> = C["uses"] extends {
  readonly members: { readonly kind: "members" };
}
  ? { readonly members: Directory }
  : Record<never, never>;
export type Range<R, K extends keyof R> = {
  [P in K]: {
    readonly column: P;
    readonly gt?: NonNullable<R[P]>;
    readonly gte?: NonNullable<R[P]>;
    readonly lt?: NonNullable<R[P]>;
    readonly lte?: NonNullable<R[P]>;
  };
}[K];
type ListWindow = {
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly cursor?: string;
};
type Filters<R, K extends keyof R> = {
  readonly eq?: Partial<Pick<R, K>>;
  readonly range?: Range<R, K>;
};
export type ListOptions<R, I extends Indexes> = ListWindow &
  (
    | ({ readonly index?: undefined } & Filters<R, Extract<"createdAt" | "id", keyof R>>)
    | {
        [N in keyof I]: { readonly index: N } & Filters<
          R,
          Extract<I[N]["columns"][number], keyof R>
        >;
      }[keyof I]
  );
type TableIndexes<T extends TableDefinition> = T["indexes"] & {
  readonly [
    N in Exclude<keyof T["columns"], keyof T["indexes"]> as T["columns"][N]["kind"] extends "ref"
      ? N
      : never
  ]: { readonly columns: readonly [N & string] };
};
export interface ReadTable<
  R extends { readonly id: string },
  I extends Indexes = Record<never, never>
> {
  readonly get: QueryCallable<R["id"], R | null>;
  getMany(ids: readonly R["id"][]): Promise<readonly (R | null)[]>;
  readonly list: QueryCallable<ListOptions<R, I> | undefined, Page<R>> & (() => Promise<Page<R>>);
}
export interface OwnedTable<
  C extends Config,
  N extends keyof C["tables"] & string
> extends ReadTable<Row<C, N>, TableIndexes<C["tables"][N]>> {
  insert(row: Insert<C, N>): Promise<Row<C, N>>;
  insertMany(rows: readonly Insert<C, N>[]): Promise<readonly Row<C, N>[]>;
  update(id: Id<N>, patch: Update<C, N>): Promise<Row<C, N>>;
  delete(id: Id<N>): Promise<null>;
}
export interface FileMetadata {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly updatedAt: string;
  readonly handle?: FileHandle;
}
export interface FilePage {
  readonly files: readonly FileMetadata[];
  readonly cursor: string | null;
}
export interface FileListOptions {
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ReadFileStore {
  get(name: string): Promise<Uint8Array>;
  download(name: string): Promise<null>;
  list(options?: FileListOptions): Promise<FilePage>;
  url(name: string): Promise<string>;
}
export interface FileStore extends ReadFileStore {
  put(
    name: string,
    bytes: Uint8Array | ArrayBuffer | Blob,
    options: { readonly contentType: string }
  ): Promise<null>;
  delete(name: string): Promise<null>;
}
export type Factory<T = unknown> = (alias: string, call: Call, queries: QueryRegistry) => T;
export type Factories = Readonly<Record<string, Factory>>;
type FactoryResults<F extends Factories> = {
  readonly [K in keyof F]: F[K] extends Factory<infer T> ? T : never;
};
type Aliases<C extends Config, Kind extends "postgres" | "sharedTable" | "sharedStore"> = {
  [N in keyof C["uses"]]: C["uses"][N]["kind"] extends Kind ? N : never;
}[keyof C["uses"]];
export type Client<
  C extends Config,
  S extends Factories = Record<never, never>,
  P extends Factories = Record<never, never>
> = DeclaredMembers<C, Members> & {
  readonly tables: { readonly [N in keyof C["tables"] & string]: OwnedTable<C, N> };
  readonly files: { readonly [N in keyof C["files"]]: FileStore };
  readonly shared: FactoryResults<S>;
  readonly connections: FactoryResults<P>;
  readonly route: Transport["route"];
  readonly download: Download;
  me(): Promise<Me | null>;
  close(): void;
};
export interface ClientManifest {
  readonly tables: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, unknown>>;
  readonly uses: Readonly<Record<string, { readonly kind: string }>>;
}

function tableQuery<Args, Result>(
  op: RuntimeSubscription["op"],
  argumentsFor: (args: Args) => Readonly<Record<string, unknown>>,
  call: Call,
  queries: QueryRegistry
): QueryCallable<Args, Result> & (() => Promise<Result>) {
  return Object.assign(
    (args: Args = undefined as Args) => call(op, argumentsFor(args)) as Promise<Result>,
    {
      subscribe: (args: Args, listener: Parameters<QueryCallable<Args, Result>["subscribe"]>[1]) =>
        queries.subscribe<Result>(op, argumentsFor(args), listener),
      __patchyQueryStore: (canonical: string) =>
        queries.getQuery<Result>(op, canonicalArgs(argumentsFor(JSON.parse(canonical))))
    }
  );
}

function createMembers(call: Call, queries: QueryRegistry): Members {
  const search = tableQuery<MemberSearchOptions, Page<Member>>(
    "members.search",
    (options) => ({ ...options }),
    call,
    queries
  );
  return {
    list: tableQuery(
      "members.list",
      (options?: MemberListOptions) => ({ ...options }),
      call,
      queries
    ),
    search: Object.assign(
      (text: string | MemberSearchOptions, options?: MemberListOptions) =>
        search(typeof text === "string" ? { ...options, text } : text),
      { subscribe: search.subscribe, __patchyQueryStore: search.__patchyQueryStore }
    ),
    get: tableQuery("members.get", (id: string) => ({ id }), call, queries),
    getMany: tableQuery("members.getMany", (ids: readonly string[]) => ({ ids }), call, queries)
  };
}

export function createSharedTable<
  R extends { readonly id: string },
  I extends Indexes = Record<never, never>
>(alias: string, call: Call, queries: QueryRegistry): ReadTable<R, I> {
  return {
    get: tableQuery("shared.get", (id: R["id"]) => ({ alias, id }), call, queries),
    getMany: (ids) => call("shared.getMany", { alias, ids }) as Promise<readonly (R | null)[]>,
    list: tableQuery(
      "shared.list",
      (options?: ListOptions<R, I>) => ({ ...options, alias }),
      call,
      queries
    )
  };
}

const closeSharedStore = Symbol("closeSharedStore");
export function createSharedStore(alias: string, call: Call): ReadFileStore {
  const urls = new Map<string, string>();
  let closed = false;
  const get = (name: string) =>
    call("shared.files.get", { alias, name }) as Promise<{
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly contentType: string;
    }>;
  const store = {
    get: async (name: string) => (await get(name)).bytes,
    list: (options: FileListOptions = {}) =>
      call("shared.files.list", { ...options, alias }) as Promise<FilePage>,
    download: (name: string) => call("shared.download", { alias, name }) as Promise<null>,
    url: async (name: string) => {
      if (closed) throw new PatchyError("unknown_outcome", "The client is closed.", {});
      // Each redemption reaches the source authority, even after a previous URL succeeded.
      const { bytes, contentType } = await get(name);
      if (closed) throw new PatchyError("unknown_outcome", "The client is closed.", {});
      const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
      const previous = urls.get(name);
      if (previous !== undefined) URL.revokeObjectURL(previous);
      urls.set(name, url);
      return url;
    },
    [closeSharedStore]() {
      closed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    }
  };
  return store;
}

/** Config is a type only; the locally executed manifest supplies the declared runtime names. */
export function createClient<
  C extends Config,
  S extends Factories = Record<never, never>,
  P extends Factories = Record<never, never>
>(
  manifest: ClientManifest,
  options: {
    readonly transport?: Transport;
    readonly shared: S & Record<Aliases<C, "sharedTable" | "sharedStore">, Factory>;
    readonly connections: P & Record<Aliases<C, "postgres">, Factory>;
  }
): Client<C, S, P> {
  const transport = options.transport ?? createPostMessageTransport();
  const call = transport.call;
  const queries = createQueryRegistry(transport.queries);
  let identity: Promise<Me | null> | undefined;
  const urls = new Map<string, Map<string, Promise<string>>>();
  let closed = false;
  const sharedStoreClosers: Array<() => void> = [];
  const tables = Object.fromEntries(
    Object.keys(manifest.tables).map((table) => {
      type R = Row<C, keyof C["tables"] & string>;
      const operations: OwnedTable<C, keyof C["tables"] & string> = {
        get: tableQuery("tables.get", (id: R["id"]) => ({ table, id }), call, queries),
        getMany: (ids) => call("tables.getMany", { table, ids }) as Promise<readonly (R | null)[]>,
        list: tableQuery(
          "tables.list",
          (args?: ListOptions<R, TableIndexes<C["tables"][keyof C["tables"] & string]>>) => {
            const options: object = args ?? {};
            return { ...options, table };
          },
          call,
          queries
        ),
        insert: (row) => call("tables.insert", { table, row }) as Promise<R>,
        insertMany: (rows) => call("tables.insertMany", { table, rows }) as Promise<readonly R[]>,
        update: (id, patch) => call("tables.update", { table, id, patch }) as Promise<R>,
        delete: (id) => call("tables.delete", { table, id }) as Promise<null>
      };
      return [table, operations];
    })
  );
  const files = Object.fromEntries(
    Object.keys(manifest.files).map((store) => {
      const cache = new Map<string, Promise<string>>();
      urls.set(store, cache);
      const invalidate = (name: string) => {
        const previous = cache.get(name);
        cache.delete(name);
        if (previous)
          void previous.then(
            (url) => URL.revokeObjectURL(url),
            () => {}
          );
      };
      const get = (name: string) =>
        call("files.get", { store, name }) as Promise<{
          readonly bytes: Uint8Array<ArrayBuffer>;
          readonly contentType: string;
        }>;
      const file: FileStore = {
        put: async (name, input, { contentType }) => {
          const bytes =
            input instanceof Uint8Array
              ? input
              : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
          await call("files.put", { store, name, contentType }, bytes);
          invalidate(name);
          return null;
        },
        get: async (name) => (await get(name)).bytes,
        download: (name) => call("download", { store, name }) as Promise<null>,
        list: (args = {}) => call("files.list", { ...args, store }) as Promise<FilePage>,
        delete: async (name) => {
          await call("files.delete", { store, name });
          invalidate(name);
          return null;
        },
        url: (name) => {
          if (closed)
            return Promise.reject(new PatchyError("unknown_outcome", "The client is closed.", {}));
          let value = cache.get(name);
          if (value) return value;
          value = get(name).then(({ bytes, contentType }) => {
            if (closed) throw new PatchyError("unknown_outcome", "The client is closed.", {});
            if (cache.get(name) !== value)
              throw new PatchyError(
                "invalid_request",
                "The file changed before its URL was available. Request it again.",
                { store, name }
              );
            return URL.createObjectURL(new Blob([bytes], { type: contentType }));
          });
          cache.set(name, value);
          void value.catch(() => {
            if (cache.get(name) === value) cache.delete(name);
          });
          return value;
        }
      };
      return [store, file];
    })
  );
  const instantiate = (factories: Factories, kinds: readonly string[]) =>
    Object.fromEntries(
      Object.entries(manifest.uses)
        .filter(([, declaration]) => kinds.includes(declaration.kind))
        .map(([alias]) => {
          if (!Object.hasOwn(factories, alias))
            throw new PatchyError(
              "invalid_request",
              `Missing generated declaration for ${alias}; run patchy refresh.`,
              {}
            );
          const value = factories[alias]!(alias, call, queries);
          if (
            typeof value === "object" &&
            value !== null &&
            closeSharedStore in value &&
            typeof value[closeSharedStore] === "function"
          )
            sharedStoreClosers.push(value[closeSharedStore] as () => void);
          return [alias, value];
        })
    );
  return {
    tables,
    files,
    shared: instantiate(options.shared, ["sharedTable", "sharedStore"]),
    connections: instantiate(options.connections, ["postgres"]),
    ...(manifest.uses.members?.kind === "members" ? { members: createMembers(call, queries) } : {}),
    route: transport.route,
    download: createDownload(call),
    me: () => (identity ??= call("me", {}) as Promise<Me | null>),
    close: () => {
      if (closed) return;
      closed = true;
      queries.close();
      transport.close();
      for (const close of sharedStoreClosers) close();
      for (const cache of urls.values()) {
        for (const value of cache.values())
          void value.then(
            (url) => URL.revokeObjectURL(url),
            () => {}
          );
        cache.clear();
      }
      urls.clear();
    }
  } as Client<C, S, P>;
}
