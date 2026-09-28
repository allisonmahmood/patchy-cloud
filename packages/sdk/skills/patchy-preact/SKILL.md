---
name: patchy-preact
description: Build a Patchy page with components, hooks or signals; handle async reads and useQuery snapshots; resolve compat or JSX import problems.
---

# Preact pages

Read `../patchy-loop/SKILL.md` first. Patchy provides Preact with compat semantics,
not React. This skill and the installed types describe Patchy's supported API;
do not link to upstream Preact documentation as the Patchy contract.

## Imports and rendering

Import components, hooks and signals from `patchy/preact`. Never import `react`,
`react-dom`, direct `preact` packages or `preact/compat`. Patchy bundles one
instance with compat already loaded, including through its JSX runtimes.
Keep `jsx: "react-jsx"` and `jsxImportSource: "patchy/preact"` in tsconfig and
`oxc.jsx.importSource: "patchy/preact"` in Vite. `react-jsx` is the compiler
setting, not a React dependency.

In the tier 1 Preact scaffold, `src/main.tsx` mounts `src/App.tsx` into the empty
HTML root. Import the generated client by relative path, for example from `src/App.tsx`:

```tsx
import { useEffect, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
```

Keep a vanilla page on the same framework-free generated client when components
are unnecessary. Refresh updates managed output, not your `src/` files.

## Hooks and compat limits

The entrypoint exports `useState`, `useReducer`, `useEffect`, `useLayoutEffect`,
`useMemo`, `useCallback`, `useRef`, `useContext`, `useId`, `useImperativeHandle`,
`useDebugValue`, `useSyncExternalStore` and `useInsertionEffect`. It also exports
signals and their hooks, plus `useQuery` as described below.

Call hooks at component or custom-hook top level, in the same order on every
render. Keep effect dependencies complete; unsubscribe and discard obsolete
async results in cleanup. Use functional state updates when an update depends
on previous state. Derived values belong in render or a memo, not a second
state copy maintained by an effect.

Compat does not provide a concurrent scheduler. `startTransition` and
`useTransition` run transitions synchronously; they do not make heavy work
interruptible. `useDeferredValue` does not defer work. `useInsertionEffect`
has layout-effect semantics. Bound expensive work and page data rather than
expecting scheduler priority to keep the UI responsive.

Use `useQuery` for subscribed table screens. For one-shot table reads or
integration reads, use an effect with visible loading and error states. Ignore
an old request's result after its inputs change or the component unmounts.
A read failure is not an empty successful result.

## useQuery

`useQuery(query, args)` accepts a table's `list` or `get` callable, including
shared tables. Pass list options or a get row id. It returns
`{ status, data, error, loading }`. Status is `"loading"`, `"ready"` or `"error"`.
Render `data` when present and show a separate error or loading notice; the hook
retains the last data through a stream error. See `../patchy-tables/SKILL.md`
for whole-result rendering, table-grain wakes and permanent errors.

The adapter shares a subscription for the same handler and canonical arguments.
Object key order does not change identity; omitted fields and object fields set
to `undefined` have the same identity. A short unmount/remount retains the
subscription. Keep query arguments JSON-compatible and call the hook at the top
level like the other hooks.

Tier 1 table subscriptions run over the shell stream in hosted company pages
and `patchy dev`. Generated server query types are available, but hosted handler
subscriptions are not admitted yet. Arbitrary promises, `getMany`, integrations,
mutations and actions are not query callables. `useFileUrl`, file handles and
staged uploads are not available yet.

## Development and helpers

The SDK initializes its own debugging support when `import.meta.env.DEV` is
true; page code does not import a debug package. That flag describes the Vite
build mode. `patchy dev` uses production build-watch, so it is false there.
It is not a test for local data and must not guard fixture inserts. Use the
local fixtures and shell workflow in `patchy-loop`.

Run `pnpm typecheck` and the scaffold's `pnpm lint` before exercising the page
through `pnpm patchy dev`. Lint checks hook usage and supported imports; fix
failures in source rather than disabling the rules.

Put reusable company code in `helpers/`, outside `server/` handler discovery.
Page-only helpers may live under `src/`. A helper imported at runtime by a page
joins the page's dependency graph: importing server code from that helper leaks
it into the page too. Keep shared helpers browser-safe, and use `import type`
for server contracts. A directory name is not an import boundary.
