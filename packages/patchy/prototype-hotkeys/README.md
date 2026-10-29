# PROTOTYPE: `patchy/hotkeys`

Throwaway. Not for merge. It answers whether TanStack Hotkeys, behind Patchy's own
API, works in the sandboxed patch frame and whether agents build with it well.

- `../src/hotkeys.ts` is the layer: `useHotkey`, `useHotkeys`, `HotkeyScope`,
  `formatHotkey`, `hotkeyKeys`, `useHotkeyList`, with `"Mod+K"`, `"?"`, `"G H"`
  strings checked at compile time. TanStack is bundled inside and never exported.
- `packages/serving/src/broker.ts` focuses the frame on load, so keys work before
  the first click.
- `demo/` is a tier 1 task tracker: G H / G T / G A / G L, C T, J / K / X, Mod+K, `?`,
  and a `/lab` route of focusable controls.
- `stress.mjs` drives the demo in the real shell: 41 checks.

## Try it

```sh
pnpm dev
export PATCHY_STATE_DIR="$PWD/.local/patch-cli"
pnpm patchy init .local/hotkeys-demo --purpose "Hotkeys demo" --json
cp -r packages/patchy/prototype-hotkeys/demo/. .local/hotkeys-demo/
cd .local/hotkeys-demo && pnpm patchy refresh && pnpm patchy dev --json
# open the url, press ? ; then, from the checkout:
node packages/patchy/prototype-hotkeys/stress.mjs <url>        # add `mac` to emulate macOS
```
