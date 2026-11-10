import { escapeAttribute, escapeHtml } from "../escape.js";

/** One choice of `choiceLinks`. */
export interface ChoiceLink {
  readonly label: string;
  readonly href: string;
  /** Trusted HTML, such as `productMark`'s. */
  readonly mark: string;
  /** Dashed, as a choice standing in for any other, such as Another agent. */
  readonly dashed?: boolean;
}

/**
 * A flow's choices drawn as tiles that are links, the one labelled `current` lit: Connect an app's
 * "Choose your app". Each choice is its own URL, so choosing needs no script and the page below
 * shows only that choice's steps. `label` names the group for assistive tech.
 */
export const choiceLinks = (spec: {
  readonly label: string;
  readonly items: ReadonlyArray<ChoiceLink>;
  readonly current: string;
}) =>
  `<nav class="choice-links" aria-label="${escapeAttribute(spec.label)}">${spec.items
    .map(
      (item) =>
        `<a class="choice-link${item.dashed === true ? " choice-link-dashed" : ""}" href="${escapeAttribute(item.href)}"${item.label === spec.current ? ' aria-current="page"' : ""}>${item.mark}<span>${escapeHtml(item.label)}</span></a>`
    )
    .join("")}</nav>`;
