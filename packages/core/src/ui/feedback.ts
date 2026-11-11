import { escapeHtml } from "../escape.js";
import { icon } from "./icons.js";

/**
 * A notice: info, warning or danger, at most one a page, beside what it is about. There is no
 * success notice; a form that worked leaves a receipt. Danger is an alert; the others are status.
 * `body` and `action` are trusted HTML.
 */
export const notice = (spec: {
  readonly tone: "info" | "warning" | "danger";
  readonly title: string;
  readonly body?: string;
  readonly action?: string;
}) =>
  `<div class="notice notice-${spec.tone}" role="${spec.tone === "danger" ? "alert" : "status"}">${icon(spec.tone === "info" ? "info" : "alert")}<p class="notice-title">${escapeHtml(spec.title)}</p>${spec.body === undefined ? "" : `<div class="notice-body">${spec.body}</div>`}${spec.action === undefined ? "" : `<div class="notice-action">${spec.action}</div>`}</div>`;

/** What the last form did, in one quiet line, shown once at the top of the page it lands on. */
export const receipt = (text: string) =>
  `<p class="receipt" role="status">${icon("done")}<span>${escapeHtml(text)}</span></p>`;

/** A state that needs a decision, as a word on its tone; plain when it only names a state. */
export const badge = (label: string, tone?: "success" | "warning" | "danger" | "info" | "yellow") =>
  `<span class="badge${tone === undefined ? "" : ` badge-${tone}`}">${escapeHtml(label)}</span>`;

/** A quiet state beside its word, such as Connected. */
export const dot = (label: string, tone?: "success" | "warning" | "danger" | "info") =>
  `<span class="dot${tone === undefined ? "" : ` dot-${tone}`}">${escapeHtml(label)}</span>`;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A patch's name, escaped, with the blue dot after it that marks a colleague's patch the viewer
 * has never opened, as unread mail is marked. It goes inside the patch's link, so the link reads
 * "Not opened yet" too. The dot keeps to the name's last character, so a phone never wraps it
 * onto a line alone, and a long name still wraps.
 */
export const unopenedName = (name: string) => {
  const characters = Array.from(graphemes.segment(name.trimEnd()), ({ segment }) => segment);
  const last = characters.pop() ?? "";
  return `${escapeHtml(characters.join(""))}<span class="unopened">${escapeHtml(last)}<span class="unseen" role="img" aria-label="Not opened yet"></span></span>`;
};

/** Where content will be, while there is none: what is missing and, at most, one way to start. */
export const emptyState = (spec: {
  readonly title: string;
  readonly body?: string;
  /** Trusted HTML, such as one `linkButton`. */
  readonly action?: string;
}) =>
  `<div class="empty"><p class="empty-title">${escapeHtml(spec.title)}</p>${spec.body === undefined ? "" : `<p class="meta">${escapeHtml(spec.body)}</p>`}${spec.action === undefined ? "" : `<div class="btn-group">${spec.action}</div>`}</div>`;
