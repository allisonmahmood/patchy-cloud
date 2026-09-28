// @effect-diagnostics globalTimers:off — The browser registry has no Effect runtime.
import { canonicalArgs } from "@patchy/api/canonical-args";

export interface QuerySnapshot<Result> {
  readonly status: "loading" | "success" | "error";
  readonly data: Result | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
}

export interface QueryStore<Result> {
  readonly getSnapshot: () => QuerySnapshot<Result>;
  /** Immediately delivers the current snapshot, then each accepted frame. */
  readonly subscribe: (onSnapshot: (snapshot: QuerySnapshot<Result>) => void) => () => void;
}

export interface QueryCallable<Args, Result> {
  (args: Args): Promise<Result>;
  readonly subscribe: (
    args: Args,
    onSnapshot: (snapshot: QuerySnapshot<Result>) => void
  ) => () => void;
  /** Internal adapter seam, taking the shared canonical JSON encoding. */
  readonly __patchyQueryStore: (canonical: string) => QueryStore<Result>;
}

export type QueryFrame<Result = unknown> =
  | { readonly status: "success"; readonly revision: number; readonly data: Result }
  | { readonly status: "error"; readonly revision: number; readonly error: Error };

export interface QueryRequest {
  readonly handler: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** A later stream transport supplies this driver. The registry never runs a handler. */
export interface QueryDriver {
  readonly subscribe: (request: QueryRequest, onFrame: (frame: QueryFrame) => void) => () => void;
}

export interface QueryRegistry {
  /** Looks up an already canonicalized argument object without encoding it again. */
  readonly getQuery: <Result>(handler: string, canonical: string) => QueryStore<Result>;
  readonly subscribe: <Result>(
    handler: string,
    args: Readonly<Record<string, unknown>>,
    onSnapshot: (snapshot: QuerySnapshot<Result>) => void
  ) => () => void;
  readonly close: () => void;
}

interface Entry {
  readonly store: QueryStore<unknown>;
  readonly listeners: Set<(snapshot: QuerySnapshot<unknown>) => void>;
  snapshot: QuerySnapshot<unknown>;
  revision: number;
  generation: number;
  running: boolean;
  stop: (() => void) | undefined;
  releaseTimer: ReturnType<typeof setTimeout> | undefined;
}

const loadingSnapshot: QuerySnapshot<never> = {
  status: "loading",
  data: undefined,
  error: undefined,
  loading: true
};

/** Create one registry per client identity and close it when that identity ends. */
export function createQueryRegistry(
  driver: QueryDriver,
  options: { readonly remountGraceMs?: number } = {}
): QueryRegistry {
  const entries = new Map<string, Entry>();
  const graceMs = options.remountGraceMs ?? 1_000;
  const closedError = new Error("The query client is closed.");
  let closed = false;

  const notify = (
    listener: (snapshot: QuerySnapshot<unknown>) => void,
    snapshot: QuerySnapshot<unknown>
  ) => {
    try {
      listener(snapshot);
    } catch (cause) {
      // A consumer's exception must not become a query error or block another consumer.
      queueMicrotask(() => {
        throw cause;
      });
    }
  };

  const publish = (entry: Entry, snapshot: QuerySnapshot<unknown>) => {
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) notify(listener, snapshot);
  };
  const stop = (entry: Entry) => {
    entry.running = false;
    entry.generation++;
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = undefined;
    const unsubscribe = entry.stop;
    entry.stop = undefined;
    unsubscribe?.();
  };
  const releaseAfterGrace = (key: string, entry: Entry) => {
    entry.releaseTimer = setTimeout(() => {
      stop(entry);
      entries.delete(key);
      entry.snapshot = loadingSnapshot;
      entry.revision = -1;
    }, graceMs);
  };
  const errorSnapshot = (entry: Entry, error: Error): QuerySnapshot<unknown> => ({
    status: "error",
    data: entry.snapshot.data,
    error,
    loading: false
  });

  const getQuery = <Result>(handler: string, encodedArgs: string): QueryStore<Result> => {
    const key = `${handler}\0${encodedArgs}`;
    const existing = entries.get(key);
    if (existing) return existing.store as QueryStore<Result>;

    // Detach the request from caller-owned objects so mutations cannot change its identity.
    const request: QueryRequest = { handler, args: JSON.parse(encodedArgs) };
    const entry: Entry = {
      snapshot: loadingSnapshot,
      revision: -1,
      generation: 0,
      running: false,
      stop: undefined,
      releaseTimer: undefined,
      listeners: new Set(),
      store: {
        getSnapshot: () => (entries.get(key) ?? entry).snapshot,
        subscribe(onSnapshot) {
          const current = entries.get(key);
          if (current && current !== entry) return current.store.subscribe(onSnapshot);
          if (closed) {
            notify(onSnapshot, errorSnapshot(entry, closedError));
            return () => {};
          }
          entries.set(key, entry);
          clearTimeout(entry.releaseTimer);
          entry.releaseTimer = undefined;
          // Two subscriptions with the same callback still own separate references.
          const listener = (snapshot: QuerySnapshot<unknown>) => onSnapshot(snapshot);
          entry.listeners.add(listener);
          notify(listener, entry.snapshot);
          if (!entry.running && !closed) {
            entry.running = true;
            const generation = ++entry.generation;
            try {
              const unsubscribe = driver.subscribe(request, (frame) => {
                if (closed || !entry.running || generation !== entry.generation) return;
                // A scalar comparison drops duplicate and stale results without inspecting data.
                if (frame.revision <= entry.revision) return;
                entry.revision = frame.revision;
                publish(
                  entry,
                  frame.status === "success"
                    ? { status: "success", data: frame.data, error: undefined, loading: false }
                    : errorSnapshot(entry, frame.error)
                );
              });
              if (entry.running && generation === entry.generation) entry.stop = unsubscribe;
              else unsubscribe();
            } catch (cause) {
              if (!closed) {
                publish(
                  entry,
                  errorSnapshot(
                    entry,
                    cause instanceof Error
                      ? cause
                      : new Error("Query subscription failed.", { cause })
                  )
                );
              }
            }
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            entry.listeners.delete(listener);
            if (closed || entry.listeners.size !== 0) return;
            releaseAfterGrace(key, entry);
          };
        }
      }
    };
    if (closed) entry.snapshot = errorSnapshot(entry, closedError);
    else {
      entries.set(key, entry);
      // Rendering can acquire a store without ever mounting a subscriber.
      releaseAfterGrace(key, entry);
    }
    return entry.store as QueryStore<Result>;
  };

  return {
    getQuery,
    subscribe: <Result>(
      handler: string,
      args: Readonly<Record<string, unknown>>,
      onSnapshot: (snapshot: QuerySnapshot<Result>) => void
    ) => getQuery<Result>(handler, canonicalArgs(args)).subscribe(onSnapshot),
    close() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) {
        stop(entry);
        publish(entry, errorSnapshot(entry, closedError));
        entry.listeners.clear();
      }
      entries.clear();
    }
  };
}
