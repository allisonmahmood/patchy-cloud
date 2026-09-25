// @effect-diagnostics globalTimers:off
// Browser client with no Effect runtime in the bundle; the subscription grace window is a platform timer.
import type { Config, Id, Indexes, Insert, Json, Row, TableDefinition, Update } from "./config.js";
import {
  createPostMessageTransport,
  type Call,
  type Me,
  type Transport
} from "./clientTransport.js";
import { PatchyError } from "./clientError.js";
// PROTOTYPE for #314
import { HandlerError } from "./handlerError.js";
import type { ServerClient, SubscribeOptions, Unsubscribe } from "./server.js";
export * from "./clientError.js";
export { HandlerError, isHandlerError } from "./handlerError.js";
export type {
  Call,
  Me,
  Operation,
  Route,
  SubscriptionEvent,
  Transport
} from "./clientTransport.js";
export type { SubscribeOptions, SubscriptionStatus, Unsubscribe } from "./server.js";

type Reply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly details?: Json };

/** The one canonicalisation of subscription arguments: sorted keys, no undefined. */
const canonical = (value: unknown): string => {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
              .map((key) => [key, sort((item as Record<string, unknown>)[key])])
          )
        : item;
  return JSON.stringify(sort(value));
};

const GRACE_MS = 1000;
interface Entry {
  readonly listeners: Set<{
    readonly onSnapshot: (value: unknown) => void;
    readonly options: SubscribeOptions;
  }>;
  unsubscribe?: Unsubscribe;
  revision: number;
  last: { readonly reply: Reply } | undefined;
  grace?: ReturnType<typeof setTimeout>;
}

/**
 * PROTOTYPE for #314 round 3 (#313's registry): one live subscription per handler and
 * canonical arguments, shared by every caller (refcount), kept for a grace second after the
 * last unsubscribe so a remount reuses it; a per-subscription revision drops stale or
 * duplicate snapshots. A handler error in a re-run reaches `onError`; the last good value stays.
 */
function createRegistry(transport: Transport) {
  const entries = new Map<string, Entry>();
  const deliver = (
    listener: { onSnapshot: (value: unknown) => void; options: SubscribeOptions },
    reply: Reply
  ) =>
    reply.ok
      ? listener.onSnapshot(reply.value)
      : listener.options.onError?.(new HandlerError(reply.code, reply.details));
  return (
    handler: string,
    args: unknown,
    onSnapshot: (value: unknown) => void,
    options: SubscribeOptions = {}
  ): Unsubscribe => {
    const key = `${handler} ${canonical(args)}`;
    let entry = entries.get(key);
    if (entry === undefined) {
      const created: Entry = { listeners: new Set(), revision: 0, last: undefined };
      entry = created;
      entries.set(key, created);
      created.unsubscribe = transport.subscribe("server.call", { handler, args }, (event) => {
        if (event.type === "snapshot") {
          if (event.revision <= created.revision) return;
          created.revision = event.revision;
          const reply = event.value as Reply;
          created.last = { reply };
          for (const listener of created.listeners) deliver(listener, reply);
        } else if (event.type === "must-resync") {
          // Continuity was lost: the next snapshot starts a new revision clock. Data is kept.
          created.revision = 0;
          for (const listener of created.listeners) listener.options.onStatus?.("resyncing");
        } else if (event.type === "up-to-date") {
          for (const listener of created.listeners) listener.options.onStatus?.("up-to-date");
        } else if (event.type === "stop") {
          for (const listener of created.listeners) listener.options.onStatus?.("stopped");
        } else {
          for (const listener of created.listeners) listener.options.onError?.(event.error);
        }
      });
    }
    clearTimeout(entry.grace);
    const listener = { onSnapshot, options };
    entry.listeners.add(listener);
    if (entry.last !== undefined) deliver(listener, entry.last.reply);
    return () => {
      const current = entries.get(key);
      if (current === undefined || !current.listeners.delete(listener)) return;
      if (current.listeners.size > 0) return;
      current.grace = setTimeout(() => {
        if (entries.get(key) !== current || current.listeners.size > 0) return;
        entries.delete(key);
        current.unsubscribe?.();
      }, GRACE_MS);
    };
  };
}

export interface Page<R> {
  readonly rows: readonly R[];
  readonly cursor: string | null;
}
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
export type TableIndexes<T extends TableDefinition> = T["indexes"] & {
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
  get(id: R["id"]): Promise<R | null>;
  getMany(ids: readonly R["id"][]): Promise<readonly (R | null)[]>;
  list(options?: ListOptions<R, I>): Promise<Page<R>>;
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
export interface FileStore {
  put(
    name: string,
    bytes: Uint8Array | ArrayBuffer | Blob,
    options: { readonly contentType: string }
  ): Promise<null>;
  get(name: string): Promise<Uint8Array>;
  download(name: string): Promise<null>;
  list(options?: FileListOptions): Promise<FilePage>;
  delete(name: string): Promise<null>;
  url(name: string): Promise<string>;
}
export type Factory<T = unknown> = (alias: string, call: Call) => T;
export type Factories = Readonly<Record<string, Factory>>;
type FactoryResults<F extends Factories> = {
  readonly [K in keyof F]: F[K] extends Factory<infer T> ? T : never;
};
type Aliases<C extends Config, Kind extends "postgres" | "sharedTable"> = {
  [N in keyof C["uses"]]: C["uses"][N]["kind"] extends Kind ? N : never;
}[keyof C["uses"]];
export interface Client<
  C extends Config,
  S extends Factories = Record<never, never>,
  P extends Factories = Record<never, never>,
  M = Record<never, never>
> {
  readonly tables: { readonly [N in keyof C["tables"] & string]: OwnedTable<C, N> };
  readonly files: { readonly [N in keyof C["files"]]: FileStore };
  readonly shared: FactoryResults<S>;
  readonly connections: FactoryResults<P>;
  /** PROTOTYPE for #314: `patchy.server.<module>.<export>(args)` on a tier 2 version. */
  readonly server: ServerClient<M, C>;
  readonly route: Transport["route"];
  me(): Promise<Me | null>;
  close(): void;
}
export interface ClientManifest {
  readonly tables: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, unknown>>;
  readonly uses: Readonly<Record<string, { readonly kind: string }>>;
}

export function createSharedTable<
  R extends { readonly id: string },
  I extends Indexes = Record<never, never>
>(alias: string, call: Call): ReadTable<R, I> {
  return {
    get: (id) => call("shared.get", { alias, id }) as Promise<R | null>,
    getMany: (ids) => call("shared.getMany", { alias, ids }) as Promise<readonly (R | null)[]>,
    list: (options = {}) => call("shared.list", { ...options, alias }) as Promise<Page<R>>
  };
}

/**
 * PROTOTYPE for #314: `patchy.server.<module>.<export>(args)`. A handler's own error arrives as
 * a successful reply with `source: "handler"` and is rethrown as `HandlerError`; a Patchy
 * refusal is a `PatchyError` as for every other operation. Modules are the `server/*.ts` names
 * generation saw; a new file needs `patchy refresh`, a changed export does not.
 */
export function createServerClient<M, C extends Config>(
  modules: readonly string[],
  call: Call,
  /** PROTOTYPE for #314 round 3: the transport subscriptions ride; omitted, `.subscribe` throws. */
  transport?: Transport
): ServerClient<M, C> {
  const register = transport === undefined ? undefined : createRegistry(transport);
  const entries = modules.map((module) => {
    const handlers = new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === "string"
            ? Object.assign(
                async (args: unknown = {}) => {
                  const reply = (await call("server.call", {
                    handler: `${module}.${name}`,
                    args
                  })) as Reply;
                  if (reply.ok) return reply.value;
                  throw new HandlerError(reply.code, reply.details);
                },
                {
                  // Only a query may be subscribed; the server refuses anything else.
                  subscribe: (
                    args: unknown,
                    onSnapshot: (value: unknown) => void,
                    options?: SubscribeOptions
                  ): Unsubscribe => {
                    if (register === undefined)
                      throw new PatchyError(
                        "invalid_request",
                        "Subscriptions need the browser shell.",
                        {}
                      );
                    return register(`${module}.${name}`, args ?? {}, onSnapshot, options);
                  }
                }
              )
            : undefined
      }
    );
    return [module, handlers] as const;
  });
  return Object.fromEntries(entries) as ServerClient<M, C>;
}

/** Config is a type only; the locally executed manifest supplies the declared runtime names. */
export function createClient<
  C extends Config,
  S extends Factories = Record<never, never>,
  P extends Factories = Record<never, never>,
  M = Record<never, never>
>(
  manifest: ClientManifest,
  options: {
    readonly transport?: Transport;
    readonly shared: S & Record<Aliases<C, "sharedTable">, Factory>;
    readonly connections: P & Record<Aliases<C, "postgres">, Factory>;
    /** PROTOTYPE for #314: the `server/` module names generation saw. */
    readonly serverModules?: readonly string[];
  }
): Client<C, S, P, M> {
  const transport = options.transport ?? createPostMessageTransport();
  const call = transport.call;
  let identity: Promise<Me | null> | undefined;
  const urls = new Map<string, Map<string, Promise<string>>>();
  let closed = false;
  const tables = Object.fromEntries(
    Object.keys(manifest.tables).map((table) => {
      type R = Row<C, keyof C["tables"] & string>;
      const operations: OwnedTable<C, keyof C["tables"] & string> = {
        get: (id) => call("tables.get", { table, id }) as Promise<R | null>,
        getMany: (ids) => call("tables.getMany", { table, ids }) as Promise<readonly (R | null)[]>,
        list: (args = {}) => call("tables.list", { ...args, table }) as Promise<Page<R>>,
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
  const instantiate = (factories: Factories, kind: string) =>
    Object.fromEntries(
      Object.entries(manifest.uses)
        .filter(([, declaration]) => declaration.kind === kind)
        .map(([alias]) => {
          if (!Object.hasOwn(factories, alias))
            throw new PatchyError(
              "invalid_request",
              `Missing generated declaration for ${alias}; run patchy refresh.`,
              {}
            );
          return [alias, factories[alias]!(alias, call)];
        })
    );
  return {
    tables,
    files,
    shared: instantiate(options.shared, "sharedTable"),
    connections: instantiate(options.connections, "postgres"),
    server: createServerClient<M, C>(options.serverModules ?? [], call, transport),
    route: transport.route,
    me: () => (identity ??= call("me", {}) as Promise<Me | null>),
    close: () => {
      if (closed) return;
      closed = true;
      transport.close();
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
  } as Client<C, S, P, M>;
}
