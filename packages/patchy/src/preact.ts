// PROTOTYPE for #314: `patchy/preact`, the one place the compat layer is loaded (#296 point 13).
//
// Importing `preact/compat` installs its `options` hooks process-wide (React event semantics,
// `forwardRef`, portals, normalised children), so it happens here, once, before anything
// renders. A patch imports what it needs from this module and never from `react`,
// `react-dom` or `preact/compat`; the import check refuses those. Not emulated by compat and
// therefore stated in the skill: transitions are synchronous, there is no scheduler.
// `preact/debug` is the patch's own awaited dynamic import in its DEV branch, never here.
import "preact/compat";

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
