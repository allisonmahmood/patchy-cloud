import { escapeHtml } from "../escape.js";

/**
 * Another product's mark beside its name, such as an integration's: its letters on a white
 * square, flat in a list. `large` is the hero size beside a page title, inked and lifted;
 * `dashed` stands in for one that isn't listed, such as "Something else".
 */
export const productMark = (
  letters: string,
  options: { readonly large?: boolean; readonly dashed?: boolean } = {}
) =>
  `<span class="im${options.large === true ? " im-lg" : ""}${options.dashed === true ? " im-dashed" : ""}" aria-hidden="true">${escapeHtml(letters)}</span>`;
