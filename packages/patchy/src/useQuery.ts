import { canonicalArgs } from "@patchy/api/canonical-args";
import { useSyncExternalStore } from "preact/compat";
import { useMemo } from "preact/hooks";
import type { QueryCallable, QuerySnapshot } from "./queryRegistry.js";

/** Observe the registry's shared snapshot through Preact's external-store hook. */
export function useQuery<Args, Result>(
  handler: QueryCallable<Args, Result>,
  args: Args
): QuerySnapshot<Result> {
  const key = canonicalArgs(args === undefined ? {} : args);
  const query = useMemo(() => handler.__patchyQueryStore(key), [handler, key]);
  return useSyncExternalStore(query.subscribe, query.getSnapshot);
}
