/**
 * The switcher's chord, the relay's messages, the switcher's dialog as other shell UI sees it,
 * and the list it reads. The relay itself, as HTML and as a CSP source, is `switcherRelay` in
 * `@patchy/core/html`; the switcher's script, `main.ts`, loads by `switcherTag`.
 */
export { activates, claims, platformOf } from "./key.js";
export type { Platform, Press } from "./key.js";
export { openSwitcher, switcherMessage, switcherMessageKind, toggleSwitcher } from "./messages.js";
export type { FrameMessage, ShellMessage, Switcher } from "./messages.js";
export { SWITCHER_CLOSED, SWITCHER_ID, switcherOpen } from "./dialog.js";
export type { SwitcherList, SwitcherPatch, SwitcherShared } from "./list.js";
