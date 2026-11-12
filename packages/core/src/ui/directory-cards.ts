import { escapeAttribute, escapeHtml } from "../escape.js";
import { icon } from "./icons.js";

/** A directory's destinations: vertical cards on desktop, compact full-width links on phones. */
export const directoryCards = (
  items: ReadonlyArray<{
    readonly name: string;
    readonly href: string;
    readonly meta: string;
    /** Trusted HTML from a mark helper. */
    readonly mark: string;
    /** Optional decorative preview, such as a few member avatars. */
    readonly preview?: string;
    readonly action: string;
  }>
) =>
  `<ul class="directory-cards">${items.map((item) => `<li><a class="directory-card" href="${escapeAttribute(item.href)}">${item.mark}<span class="directory-card-copy"><span class="row-name">${escapeHtml(item.name)}</span><span class="meta">${escapeHtml(item.meta)}</span></span>${item.preview ? `<span class="directory-card-preview" aria-hidden="true">${item.preview}</span>` : ""}<span class="directory-card-action"><span class="directory-card-label">${escapeHtml(item.action)}</span>${icon("chevronRight")}</span></a></li>`).join("")}</ul>`;
