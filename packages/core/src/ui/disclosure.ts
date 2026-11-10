import { escapeAttribute, escapeHtml } from "../escape.js";

/**
 * A summary that opens what it holds in place, such as "No agent yet?" under a setup step:
 * ephemeral, not a URL, though a fragment naming something inside opens it with script. `body`
 * is trusted HTML whose parts sit on one gap, as a dialog's body's do.
 */
export const disclosure = (
  summary: string,
  body: string,
  options: { readonly id?: string; readonly open?: boolean } = {}
) =>
  `<details${options.id === undefined ? "" : ` id="${escapeAttribute(options.id)}"`}${options.open === true ? " open" : ""}><summary>${escapeHtml(summary)}</summary><div class="disclosure-body">${body}</div></details>`;
