import { escapeAttribute, escapeHtml } from "../escape.js";
import { icon } from "./icons.js";
import type { Parent } from "./structure.js";

/** One entry of a `listDetail`'s list. */
export interface ListEntry {
  readonly name: string;
  readonly href: string;
  readonly description?: string;
  /** The entry open beside the list. */
  readonly current?: boolean;
}

/**
 * A list beside the entry it opens, such as Teams: the entries as rows on the left, the open one
 * under its own header on the right. On a phone each is a screen of its own: `at: "list"` shows
 * the list, and `at: "entry"` the open entry, whose `parent` link goes back to the list. `meta`
 * items join with a middle dot; `meta`, `actions` and `body` are trusted HTML. `id` must be
 * unique on the page and names the entry's heading.
 */
export const listDetail = (spec: {
  readonly id: string;
  /** The list's accessible name. */
  readonly label: string;
  readonly entries: ReadonlyArray<ListEntry>;
  readonly at: "list" | "entry";
  readonly parent: Parent;
  readonly title: string;
  readonly meta?: ReadonlyArray<string>;
  readonly actions?: string;
  readonly body: string;
}) => {
  const heading = `${spec.id}-title`;
  const entries = spec.entries
    .map(
      (entry) =>
        `<div class="row row-plain list-detail-row"><div class="row-main"><span class="row-name"><a class="row-link" href="${escapeAttribute(entry.href)}"${entry.current === true ? ' aria-current="page"' : ""}>${escapeHtml(entry.name)}</a></span>${entry.description === undefined ? "" : `<span class="row-desc">${escapeHtml(entry.description)}</span>`}</div></div>`
    )
    .join("");
  const meta =
    spec.meta === undefined || spec.meta.length === 0
      ? ""
      : `<p class="ph-meta">${spec.meta.join('<span class="ph-sep" aria-hidden="true">·</span>')}</p>`;
  return `<div class="list-detail list-detail-at-${spec.at}" id="${escapeAttribute(spec.id)}"><nav class="list-detail-list" aria-label="${escapeAttribute(spec.label)}"><div class="rows box">${entries}</div></nav><section class="list-detail-entry" aria-labelledby="${escapeAttribute(heading)}"><header class="list-detail-head"><a class="ph-parent" href="${escapeAttribute(spec.parent.href)}">${icon("back")}${escapeHtml(spec.parent.label)}</a><div class="ph-row ph-row-nomark"><div class="ph-text"><h2 class="title-sm" id="${escapeAttribute(heading)}">${escapeHtml(spec.title)}</h2>${meta}</div>${spec.actions === undefined ? "" : `<div class="ph-actions">${spec.actions}</div>`}</div></header>${spec.body}</section></div>`;
};
