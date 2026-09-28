import { canonicalArgs } from "@patchy/api/canonical-args";
import { signal, type Signal } from "@preact/signals";
import { useLayoutEffect, useMemo } from "preact/hooks";
import type { QueryCallable, QuerySnapshot, QueryStore } from "./queryRegistry.js";

const snapshots = new WeakMap<QueryStore<unknown>, Signal<QuerySnapshot<unknown>>>();

/** Subscribe to a generated query, sharing its signal with other mounted consumers. */
export function useQuery<Args, Result>(
  handler: QueryCallable<Args, Result>,
  args: Args
): QuerySnapshot<Result> {
  const key = canonicalArgs(args);
  const query = useMemo(() => handler.__patchyQueryStore(key), [handler, key]);
  let snapshot = snapshots.get(query) as Signal<QuerySnapshot<Result>> | undefined;
  if (!snapshot) {
    snapshot = signal(query.getSnapshot());
    snapshots.set(query, snapshot);
  }
  const shared = snapshot;
  useLayoutEffect(
    () =>
      query.subscribe((value) => {
        shared.value = value;
      }),
    [query, shared]
  );
  return shared.value;
}
