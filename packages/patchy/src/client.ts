// @effect-diagnostics globalTimers:off
// Browser client with no Effect runtime in the bundle; the subscription grace window is a platform timer.
import type { Config, Id, Indexes, Insert, Row, TableDefinition, Update } from "./config.js";
import {
  createPostMessageTransport,
  type Call,
  type Me,
  type Operation,
  type Transport
} from "./clientTransport.js";
import { PatchyError } from "./clientError.js";
export * from "./clientError.js";
// PROTOTYPE for #313: the fixture reaches the transport directly for the postgres refusal case.
export { createPostMessageTransport } from "./clientTransport.js";
export type {
  Call,
  Me,
  Operation,
  Route,
  SubscriptionEvent,
  Transport
} from "./clientTransport.js";

// PROTOTYPE for #313, not for merge. The core owns the subscription machinery (contract
// point 9): a registry keyed by operation plus canonical arguments, a refcount, an
// unsubscribe grace window, resync handling and a per-subscription revision high-water mark
// so stale or duplicate snapshots are dropped in O(1) without deep comparison.
export type SubscriptionStatus = "up-to-date" | "resyncing" | "stopped";
export interface SubscribeOptions {
  readonly onError?: (error: PatchyError) => void;
  readonly onStatus?: (status: SubscriptionStatus) => void;
}
export type Unsubscribe = () => void;
export interface Subscribable<A, T> {
  (args: A): Promise<T>;
  subscribe(args: A, onSnapshot: (value: T) => void, options?: SubscribeOptions): Unsubscribe;
}
export type SubscribableList<A, T> = {
  (args?: A): Promise<T>;
  subscribe(
    args: A | undefined,
    onSnapshot: (value: T) => void,
    options?: SubscribeOptions
  ): Unsubscribe;
};
const GRACE_MS = 1000;
/** The one canonicalisation the server shares: sorted keys, no undefined. */
export function canonicalArguments(value: unknown): string {
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
}
interface Entry {
  readonly listeners: Set<{ onSnapshot: (value: unknown) => void; options: SubscribeOptions }>;
  unsubscribe?: Unsubscribe;
  revision: number;
  last: { value: unknown } | undefined;
  grace?: ReturnType<typeof setTimeout>;
}
/** Statistics the Playwright prototype reads; harmless otherwise. */
export const subscriptionStats = { snapshots: 0, dropped: 0, resyncs: 0 };
function createRegistry(transport: Transport) {
  const entries = new Map<string, Entry>();
  return (
    op: Operation,
    args: unknown,
    onSnapshot: (value: unknown) => void,
    options: SubscribeOptions = {}
  ): Unsubscribe => {
    const key = `${op} ${canonicalArguments(args)}`;
    let entry = entries.get(key);
    if (entry === undefined) {
      const created: Entry = { listeners: new Set(), revision: 0, last: undefined };
      entry = created;
      entries.set(key, created);
      created.unsubscribe = transport.subscribe(op, args, (event) => {
        if (event.type === "snapshot") {
          if (event.revision <= created.revision) {
            subscriptionStats.dropped += 1;
            return;
          }
          created.revision = event.revision;
          created.last = { value: event.value };
          subscriptionStats.snapshots += 1;
          for (const listener of created.listeners) listener.onSnapshot(event.value);
        } else if (event.type === "must-resync") {
          // Continuity was lost: the next snapshot starts a new revision clock. Data is kept.
          created.revision = 0;
          subscriptionStats.resyncs += 1;
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
    if (entry.last !== undefined) onSnapshot(entry.last.value);
    return () => {
      const current = entries.get(key);
      if (current === undefined || !current.listeners.delete(listener)) return;
      if (current.listeners.size > 0) return;
      // Grace window: a remount within a second reuses the live subscription.
      current.grace = setTimeout(() => {
        if (entries.get(key) !== current || current.listeners.size > 0) return;
        entries.delete(key);
        current.unsubscribe?.();
      }, GRACE_MS);
    };
  };
}
function subscribable<A, T>(
  call: Call,
  register: ReturnType<typeof createRegistry>,
  op: Operation,
  argsOf: (args: A) => unknown
): Subscribable<A, T> {
  const read = (args: A) => call(op, argsOf(args)) as Promise<T>;
  return Object.assign(read, {
    subscribe: (args: A, onSnapshot: (value: T) => void, options?: SubscribeOptions) =>
      register(op, argsOf(args), onSnapshot as (value: unknown) => void, options)
  });
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
  /** PROTOTYPE for #313: `get` and `list` also carry `.subscribe(args, onSnapshot)`. */
  get: Subscribable<R["id"], R | null>;
  getMany(ids: readonly R["id"][]): Promise<readonly (R | null)[]>;
  list: SubscribableList<ListOptions<R, I>, Page<R>>;
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
  P extends Factories = Record<never, never>
> {
  readonly tables: { readonly [N in keyof C["tables"] & string]: OwnedTable<C, N> };
  readonly files: { readonly [N in keyof C["files"]]: FileStore };
  readonly shared: FactoryResults<S>;
  readonly connections: FactoryResults<P>;
  readonly route: Transport["route"];
  me(): Promise<Me | null>;
  close(): void;
}
export interface ClientManifest {
  readonly tables: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, unknown>>;
  readonly uses: Readonly<Record<string, { readonly kind: string }>>;
}

/** Factories receive only `call`; shared tables get a registry over the same transport-less seam. */
const registries = new WeakMap<Call, ReturnType<typeof createRegistry>>();
const registryFor = (call: Call, transport?: Transport) => {
  let registry = registries.get(call);
  if (registry === undefined) {
    registry = createRegistry(
      transport ?? {
        call,
        route: {
          get: () => Promise.reject(),
          set: () => Promise.reject(),
          subscribe: () => () => {}
        },
        subscribe: () => () => {},
        close: () => {}
      }
    );
    registries.set(call, registry);
  }
  return registry;
};

export function createSharedTable<
  R extends { readonly id: string },
  I extends Indexes = Record<never, never>
>(alias: string, call: Call): ReadTable<R, I> {
  const register = registryFor(call);
  return {
    get: subscribable<R["id"], R | null>(call, register, "shared.get", (id) => ({ alias, id })),
    getMany: (ids) => call("shared.getMany", { alias, ids }) as Promise<readonly (R | null)[]>,
    list: subscribable<ListOptions<R, I> | undefined, Page<R>>(
      call,
      register,
      "shared.list",
      (options = {}) => ({ ...options, alias })
    )
  };
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
    readonly shared: S & Record<Aliases<C, "sharedTable">, Factory>;
    readonly connections: P & Record<Aliases<C, "postgres">, Factory>;
  }
): Client<C, S, P> {
  const transport = options.transport ?? createPostMessageTransport();
  const call = transport.call;
  const register = registryFor(call, transport);
  let identity: Promise<Me | null> | undefined;
  const urls = new Map<string, Map<string, Promise<string>>>();
  let closed = false;
  const tables = Object.fromEntries(
    Object.keys(manifest.tables).map((table) => {
      type R = Row<C, keyof C["tables"] & string>;
      type I = TableIndexes<C["tables"][keyof C["tables"] & string]>;
      const operations: OwnedTable<C, keyof C["tables"] & string> = {
        get: subscribable<R["id"], R | null>(call, register, "tables.get", (id) => ({ table, id })),
        getMany: (ids) => call("tables.getMany", { table, ids }) as Promise<readonly (R | null)[]>,
        list: subscribable<ListOptions<R, I> | undefined, Page<R>>(
          call,
          register,
          "tables.list",
          (args = {}) => ({ ...args, table })
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
  } as Client<C, S, P>;
}
