---
name: patchy-preact
description: Build the browser UI of a patch with Preact through patchy/preact (compat semantics), including what compat does not emulate and which imports are refused. Read before writing src/.
---

<!-- PROTOTYPE for #314 -->

# Preact with compat semantics

The scaffold's UI is Preact 10 with its compatibility layer loaded once by `patchy/preact`, before anything renders. Write components in the React idiom you know; do not call it React and do not install React. Two rules the build enforces:

- Import `render`, hooks, `forwardRef`, `memo`, `createPortal` and signals from `patchy/preact`. Imports of `react`, `react-dom` and `preact/compat` are refused by the build (`Import of "react" ... is refused`). `preact` and `@preact/signals` themselves are on the allowlist; `preact/jsx-runtime` is what your JSX compiles to.
- Everything else comes from `patchy` or the release's allowlist; any other bare import fails with `copy it into src/ or ask Patchy for the capability`.

## The scaffold

`index.html` has an empty `<div id="root">`; `src/main.tsx` awaits `preact/debug` in a `DEV` branch and renders `<App />`; `src/App.tsx` is the tool. `tsconfig.json` (`jsx: react-jsx`, `jsxImportSource: preact`, `isolatedModules`, `verbatimModuleSyntax`) and `vite.config.ts` (`oxc.jsx.importSource: "preact"`, `build.modulePreload: false`) name the same runtime; keep them in step. Exact pins of `preact` and `@preact/signals` live in `dependencies`. No router, CSS framework, state library or test runner; `pnpm typecheck` plus the dev shell is the gate.

## What compat gives you

`onChange` on a text input fires per keystroke, `onDoubleClick`, `onFocus`/`onBlur`, `className`, `defaultValue`, `e.persist()`, a `ref` on a function component (`forwardRef`), `createPortal`, `memo`, normalised `props.children`.

## What compat does not emulate

- `startTransition` runs synchronously and `useTransition` never reports pending; there is no scheduler and no concurrent rendering.
- `flushSync` is a real synchronous flush.
- Never import `react`, `react-dom` or `preact/compat` directly, and keep exactly one copy of `preact` and of `@preact/signals` in the bundle; the build resolves both to the patch's own installation.

## Data

Call handlers with `patchy.server.<module>.<export>(args)` from an event handler or a `useEffect`; hold results in `useState` or a signal. For a live list, subscribe to a query in a `useEffect` and return the unsubscribe: `useEffect(() => patchy.server.notes.list.subscribe({}, setNotes), [])` (see `../patchy-server/SKILL.md`; there is no `useQuery` in this release). Without a subscription, read again after a mutation. Branch on `isHandlerError(error, "<code>")` for a handler's own errors and treat `PatchyError`s as the platform's. Native form submission is blocked in the frame: use `type="button"` and an Enter handler that calls the handler, with `event.preventDefault()` on the form.
