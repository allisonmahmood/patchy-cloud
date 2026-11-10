import { escapeAttribute, escapeHtml } from "../escape.js";
import type { ChangeKind } from "../whatsNew.js";
import { icon } from "./icons.js";

/**
 * A disclosure on one line, its kind column then its title, opening in place to its body. An `id`
 * names the body, so a fragment naming it opens the disclosure without script too: browsers
 * reveal a closed `<details>` around the element a fragment names, never the `<details>` itself.
 */
const entry = (open: boolean, kind: string, title: string, body: string, id?: string) =>
  `<details class="change"${open ? " open" : ""}><summary class="change-head"><span class="change-kind">${kind}</span>${title}${icon("chevronRight")}</summary><div class="change-body"${id === undefined ? "" : ` id="${escapeAttribute(id)}"`}>${body}</div></details>`;

/**
 * One change on a month of What's new: its kind in muted text and its title on one line, opening
 * in place to its detail and a link to itself. `id` is the permalink's fragment, which opens it;
 * one new to the viewer starts open, with the new-to-you dot.
 */
export const changeEntry = (spec: {
  readonly id: string;
  readonly href: string;
  readonly kind: ChangeKind;
  readonly title: string;
  readonly detail: string;
  readonly unseen: boolean;
}) =>
  entry(
    spec.unseen,
    spec.kind,
    `<span class="change-title">${escapeHtml(spec.title)}${spec.unseen ? '<span class="whats-new-dot" role="img" aria-label="New to you"></span>' : ""}</span>`,
    `<p class="prose">${escapeHtml(spec.detail)}</p><p class="meta"><a href="${escapeAttribute(spec.href)}">Link to this change</a></p>`,
    spec.id
  );

/** A day's behind-the-scenes lines, the work nobody would notice, folded into one quiet entry. */
export const behindTheScenes = (lines: ReadonlyArray<string>) =>
  entry(
    false,
    "",
    `<span class="change-title change-quiet">Behind the scenes · ${lines.length} ${lines.length === 1 ? "change" : "changes"}</span>`,
    `<ul class="change-lines">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
  );
