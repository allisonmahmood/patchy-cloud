/**
 * The switcher's chord and the relay's messages, for the browser code that answers them. The
 * relay itself, as HTML and as a CSP source, is `switcherRelay` in `@patchy/core/html`.
 */
export { activates, claims, platformOf } from "./key.js";
export type { Platform, Press } from "./key.js";
export { requestSwitcher, switcherMessage, switcherMessageKind } from "./messages.js";
export type { FrameMessage, ShellMessage } from "./messages.js";
