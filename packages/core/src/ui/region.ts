import { escapeAttribute, escapeHtml } from "../escape.js";

/**
 * A `section` that is a named region, its title its name, for a page of several sections someone
 * moves between by landmark, such as Home's. `id` must be unique on the page; the title's id is
 * `<id>-title`. `action` and `body` are trusted HTML.
 */
export const region = (spec: {
  readonly id: string;
  readonly title: string;
  readonly action?: string;
  readonly body: string;
}) =>
  `<section class="section" id="${escapeAttribute(spec.id)}" aria-labelledby="${escapeAttribute(`${spec.id}-title`)}"><div class="section-head"><div><h2 class="section-title" id="${escapeAttribute(`${spec.id}-title`)}">${escapeHtml(spec.title)}</h2></div>${spec.action ?? ""}</div>${spec.body}</section>`;
