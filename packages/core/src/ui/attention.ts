import { escapeAttribute, escapeHtml } from "../escape.js";

/**
 * A row that says what broke, for a list of things that need someone: its name, the problem in
 * danger text and a quiet detail after it, and the one action that fixes it at its end. The whole
 * row opens the thing; the fix stays pressable above that link. `lead` and `fix` are trusted HTML.
 */
export const attentionRow = (spec: {
  readonly lead?: string;
  readonly name: string;
  readonly href: string;
  readonly problem: string;
  readonly detail?: string;
  readonly fix: string;
}) =>
  `<div class="row${spec.lead === undefined ? " row-plain" : ""}">${spec.lead ?? ""}<div class="row-main"><span class="row-name"><a class="row-link" href="${escapeAttribute(spec.href)}">${escapeHtml(spec.name)}</a></span><span class="row-desc"><span class="danger-text">${escapeHtml(spec.problem)}</span>${spec.detail === undefined ? "" : ` · ${escapeHtml(spec.detail)}`}</span></div><div class="row-end">${spec.fix}</div></div>`;
