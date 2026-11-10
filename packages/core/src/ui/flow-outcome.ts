import { escapeHtml } from "../escape.js";

/**
 * What a flow leads to, after its numbered sections and on the flow's own gap: Once connected
 * and what it can and can't do. For `flowPage`'s `outcome`; `body` is trusted HTML, usually
 * `canList` output.
 */
export const flowOutcome = (spec: { readonly title: string; readonly body: string }) =>
  `<section class="flow-outcome"><h2 class="section-title">${escapeHtml(spec.title)}</h2>${spec.body}</section>`;
