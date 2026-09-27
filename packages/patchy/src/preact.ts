// PROTOTYPE for #314: `patchy/preact`, the one place the compat layer is loaded (#296 point 13).
//
// Importing `preact/compat` installs its `options` hooks process-wide (React event semantics,
// `forwardRef`, portals, normalised children), so it happens here, once, before anything
// renders. A patch imports what it needs from this module and never from `react`,
// `react-dom` or `preact/compat`; the import check refuses those. Not emulated by compat and
// therefore stated in the skill: transitions are synchronous, there is no scheduler.
// `preact/debug` is the patch's own awaited dynamic import in its DEV branch, never here.
import "preact/compat";
// PROTOTYPE for #315: the tier 2 page hooks below.
import { useEffect as useEffectHook, useState as useStateHook } from "preact/compat";
import { currentPageFiles } from "./client.js";
import { PatchyError } from "./clientError.js";
import type { FileHandle } from "./config.js";
import type { QueryClient, SubscriptionStatus } from "./server.js";

export {
  render,
  createContext,
  createRef,
  Fragment,
  forwardRef,
  memo,
  createPortal,
  startTransition,
  useTransition,
  flushSync,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  useReducer,
  useContext,
  useId
} from "preact/compat";
export type { ComponentChildren, JSX, RefObject, VNode, FunctionComponent } from "preact";
export {
  signal,
  computed,
  effect,
  batch,
  useSignal,
  useComputed,
  useSignalEffect
} from "@preact/signals";

/**
 * PROTOTYPE for #315: a blob URL for a handle a handler returned, for `<img src>`. `url` is
 * undefined while loading and on failure; `error` is the PatchyError (`not_found` once the file
 * was replaced or deleted, `access_denied` once the viewer lost its store). The URL is released
 * when the handle changes or the component unmounts; a failure never keeps a stale image.
 */
export function useFileUrl(handle: FileHandle | null | undefined): {
  readonly url: string | undefined;
  readonly error: PatchyError | undefined;
} {
  const [state, setState] = useStateHook<{
    readonly handle: FileHandle | null | undefined;
    readonly url?: string;
    readonly error?: PatchyError;
  }>({ handle });
  useEffectHook(() => {
    setState({ handle });
    if (handle === null || handle === undefined) return;
    const files = currentPageFiles();
    if (files === undefined) {
      setState({
        handle,
        error: new PatchyError(
          "invalid_request",
          "useFileUrl needs the tier 2 client; import patchy from patchy/_generated/client first.",
          {}
        )
      });
      return;
    }
    let live = true;
    let url: string | undefined;
    files.url(handle).then(
      (created) => {
        if (!live) return URL.revokeObjectURL(created);
        url = created;
        setState({ handle, url: created });
      },
      (error: unknown) => {
        if (live)
          setState({
            handle,
            // Structural: patchy/client is a separate bundle with its own PatchyError class.
            error:
              error instanceof Error && error.name === "PatchyError"
                ? (error as PatchyError)
                : new PatchyError("unknown_outcome", "The file could not be read.", {})
          });
      }
    );
    return () => {
      live = false;
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [handle]);
  return state.handle === handle
    ? { url: state.url, error: state.error }
    : { url: undefined, error: undefined };
}

/**
 * PROTOTYPE for #315: a live query. Subscribes `query(args)` while mounted and re-renders on
 * every changed result. `data` is the last good value; when `error` is set (a HandlerError from
 * a re-run, or a PatchyError such as a shared source refusing), `data` may be stale: show the
 * error. `status` is `loading` until the first result, then `up-to-date`, or `resyncing` while
 * the shell re-runs it after a reconnect or after the document was hidden.
 */
export function useQuery<A, T>(
  query: QueryClient<A, T>,
  args: A
): {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly status: SubscriptionStatus | "loading";
} {
  const key = JSON.stringify(args);
  const [state, setState] = useStateHook<{
    readonly key: string;
    readonly data?: T;
    readonly error?: Error;
    readonly status: SubscriptionStatus | "loading";
  }>({ key, status: "loading" });
  useEffectHook(() => {
    setState({ key, status: "loading" });
    return query.subscribe(
      JSON.parse(key) as A,
      (value) =>
        setState((previous) => ({
          key,
          data: value,
          status: previous.status === "loading" ? "up-to-date" : previous.status
        })),
      {
        onError: (error) => setState((previous) => ({ ...previous, key, error })),
        onStatus: (status) => setState((previous) => ({ ...previous, key, status }))
      }
    );
  }, [query, key]);
  return state.key === key
    ? { data: state.data, error: state.error, status: state.status }
    : { data: undefined, error: undefined, status: "loading" };
}
