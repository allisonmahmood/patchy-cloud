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

In the tier 1 and tier 2 Preact scaffolds, `src/main.tsx` mounts `src/App.tsx` into
the empty HTML root. Import the generated client by relative path, for example from `src/App.tsx`:

```tsx
import { useEffect, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
```

Keep a vanilla page on the same framework-free generated client when components
are unnecessary. Refresh updates managed output, not your `src/` files.
Tier 2 pages call `patchy.server.<module>.<handler>`; move direct resource calls
into `server/` handlers. `patchy-loop` owns the config-and-refresh steps for
moving tiers, and `patchy-server` owns handler kinds and their availability.

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

Use `useQuery` for subscribed screens: tier 1 table reads or tier 2 server
queries. For one-shot reads, use an effect with visible loading and error states.
Ignore an old request's result after its inputs change or the component unmounts.
A read failure is not an empty successful result.

## useQuery

`useQuery(query, args)` accepts a tier 1 table's `list` or `get` callable,
including shared tables, or a tier 2 generated server query. Pass list options,
a get row id, or the handler's declared arguments:

```tsx
const snapshot = useQuery(patchy.server.leads.list, { stage: "open" });
```

It returns `{ status, data, error, loading }`. Status is `"loading"`, `"ready"`
or `"error"`. Render the whole `data` value when present and show a separate
error or loading notice. Both recoverable and permanent errors keep the last
successful data. A first-run failure has `data: undefined`, not an empty result.
Source refusals inside a server handler recover after access returns.
`handler_failed`, invalid results and a removed handler end the subscription
with its last data kept. Another consumer or a reconnect does not restart it.
Loss of document authority instead produces the shell's stopping notice.

The adapter shares a subscription for the same handler and canonical arguments.
Object key order does not change identity; omitted fields and object fields set
to `undefined` have the same identity. A remount within about one second retains
the subscription. Hidden documents suspend after 30 seconds and reconcile on
return. Keep query arguments JSON-compatible and call the hook at the top level.
Signals, this hook, ordinary hooks and compat components use the same installed
Preact runtime; leave Vite dependency optimisation enabled.

After a mutation, keep rendering the subscribed result rather than maintaining
a second copy of server data. Read only what the screen needs, since resources
read by a handler determine which changes wake it. Member-directory reads are
outside the query's company-database snapshot. See `../patchy-server/SKILL.md`
for handler dependencies, failures and bounds, or `../patchy-tables/SKILL.md`
for whole-result rendering and table-grain wakes on tier 1.

Tier 1 table subscriptions run in hosted company pages and `patchy dev`.
Tier 2 query subscriptions run on published patches in dev and test instances;
the tier 2 `patchy dev` engine and production fleet hosting remain separate.
Arbitrary promises, `getMany`, integrations, mutations and actions are not query
callables. `useFileUrl`, file handles and staged uploads are not available yet.

## Development and helpers

The SDK initializes its own debugging support when `import.meta.env.DEV` is
true; page code does not import a debug package. That flag describes the Vite
build mode. `patchy dev` uses production build-watch, so it is false there.
It is not a test for local data and must not guard fixture inserts. Use the
local fixtures and shell workflow in `patchy-loop`.

Run `pnpm typecheck` and the scaffold's `pnpm lint`, then exercise tier 1 through
`pnpm patchy dev`. For tier 2, follow `patchy-server`'s current runtime boundary.
Lint checks hook usage and supported imports; fix failures in source rather
than disabling the rules.

Put reusable company code in `helpers/`, outside `server/` handler discovery.
Page-only helpers may live under `src/`. A helper imported at runtime by a page
joins the page's dependency graph: importing server code from that helper leaks
it into the page too. Keep shared helpers browser-safe, and use `import type`
for server contracts. A directory name is not an import boundary.
