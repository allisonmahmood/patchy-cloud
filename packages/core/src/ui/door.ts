import { escapeAttribute, escapeHtml } from "../escape.js";
import { icon } from "./icons.js";
import type { Template } from "./templates.js";

/**
 * The door's card around a `doorPage`: the brand, then the template's kicker and title, then its
 * body. `pageResponse` draws every door with it, and Serving's notices, which answer outside
 * auth, draw theirs the same way. `data` marks the card for a script or a test, such as a
 * stopping notice's code.
 */
export const doorCard = (
  door: Template,
  options: { readonly data?: Readonly<Record<string, string>> } = {}
) =>
  `<main class="auth-card"${Object.entries(options.data ?? {})
    .map(([key, value]) => ` data-${escapeAttribute(key)}="${escapeAttribute(value)}"`)
    .join(
      ""
    )}><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div>${door.heading}${door.body}</main>`;

/**
 * A code a person compares with the one another screen shows, such as a device login's, in
 * tabular mono at the size of a title. The separator stays in the text, so the code reads and
 * matches as one string.
 */
export const verificationCode = (code: string) => `<p class="code-display">${escapeHtml(code)}</p>`;

/** One side of `meet`: its mark (trusted HTML), its name and one line under it. */
export interface Party {
  readonly mark: string;
  readonly name: string;
  readonly meta?: string;
}

const party = ({ mark, name, meta }: Party) =>
  `<div class="meet-party">${mark}<span class="strong">${escapeHtml(name)}</span>${meta === undefined ? "" : `<span class="meta">${escapeHtml(meta)}</span>`}</div>`;

const arrow =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';

/**
 * Who meets whom, before a person lets one act as the other: an app on the left, the person on
 * the right. `relation` is what the arrow says to assistive tech, such as "wants to act as".
 */
export const meet = (from: Party, relation: string, to: Party) =>
  `<div class="meet">${party(from)}<span class="meet-arrow">${arrow}<span class="sr-only">${escapeHtml(relation)}</span></span>${party(to)}</div>`;

/**
 * What something will and won't be able to do, one sentence each: a check for what it can, a
 * cross for what it can't. Each sentence says which on its own, so the mark is never the only
 * sign. Consent draws it, and so does a connect flow's "Once connected", for an agent or an
 * integration.
 */
export const canList = (items: ReadonlyArray<{ readonly can: boolean; readonly text: string }>) =>
  `<ul class="can">${items
    .map(
      (item) =>
        `<li class="${item.can ? "can-yes" : "can-no"}">${icon(item.can ? "check" : "close")}<span>${escapeHtml(item.text)}</span></li>`
    )
    .join("")}</ul>`;

/**
 * Two answers of equal weight side by side, such as Deny and Allow, as wide as what holds them.
 * Both are trusted HTML, usually `button` output.
 */
export const answerPair = (first: string, second: string) =>
  `<div class="btn-pair">${first}${second}</div>`;
