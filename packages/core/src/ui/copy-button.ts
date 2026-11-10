import { escapeAttribute, escapeHtml } from "../escape.js";

/**
 * A button that copies `text`, such as a patch's link, where a whole `copyLine` has no room. It
 * waits hidden for the page's copy script (`copyScriptPath`), which reveals it, so a page without
 * script never offers a button that does nothing. `ariaLabel` names what it copies, "Copy link to
 * Kudos", when the label alone doesn't.
 */
export const copyButton = (
  text: string,
  options: { readonly label?: string; readonly ariaLabel?: string; readonly size?: "sm" } = {}
) =>
  `<button class="btn${options.size === "sm" ? " btn-sm" : ""} copy-button" type="button" data-copy="${escapeAttribute(text)}"${options.ariaLabel === undefined ? "" : ` aria-label="${escapeAttribute(options.ariaLabel)}"`} aria-live="polite" hidden>${escapeHtml(options.label ?? "Copy")}</button>`;
