import { escapeAttribute, escapeHtml } from "../escape.js";
import { buttonClass, type ButtonLook } from "./controls.js";

/**
 * A button that copies `text`, such as a patch's link, where a whole `copyLine` has no room. It
 * waits hidden for the page's copy script (`copyScriptPath`), which reveals it, so a page without
 * script never offers a button that does nothing. `ariaLabel` names what it copies, "Copy link to
 * Kudos", when the label alone doesn't; `kind: "quiet"` suits a line's own Copy, such as an
 * address in a header's meta.
 */
export const copyButton = (
  text: string,
  options: Pick<ButtonLook, "kind" | "size" | "ariaLabel"> & { readonly label?: string } = {}
) =>
  `<button class="${buttonClass(options, "copy-button")}" type="button" data-copy="${escapeAttribute(text)}"${options.ariaLabel === undefined ? "" : ` aria-label="${escapeAttribute(options.ariaLabel)}"`} aria-live="polite" hidden>${escapeHtml(options.label ?? "Copy")}</button>`;
