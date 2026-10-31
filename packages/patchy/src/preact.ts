import "./preact/runtime.js";

export {
  Children,
  Component,
  Fragment,
  PureComponent,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createPortal,
  createRef,
  forwardRef,
  hydrate,
  isValidElement,
  lazy,
  memo,
  render,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition
} from "preact/compat";
export { h } from "preact";
export * from "@preact/signals";
// Preact's own types, including the attribute and event types that Preact 11 moved out of `JSX`.
export type * from "preact";
// Compat's component types keep `defaultProps`, which compat still applies.
export type { ComponentClass, FunctionComponent } from "preact/compat";
export { useQuery } from "./useQuery.js";
export { useFileUrl } from "./useFileUrl.js";
export type { QuerySnapshot } from "./queryRegistry.js";
