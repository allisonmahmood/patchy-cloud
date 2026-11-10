import { escapeHtml } from "../escape.js";
import { icon, type IconName } from "./icons.js";
import { productLogo, type ProductLogo } from "./logos.js";

/**
 * What a product mark shows: the product's own logo where Patchy knows it, an icon for a kind of
 * product rather than one product, such as email's envelope, or else its letters.
 */
export type ProductMark = string | { readonly logo: ProductLogo } | { readonly icon: IconName };

/**
 * Another product's mark beside its name, such as an integration's: its logo in its colours, an
 * icon, or its letters, on a white square, flat in a list. `large` is the hero size beside a page
 * title, inked and lifted; `dashed` stands in for one that isn't listed, such as "Something else".
 */
export const productMark = (
  mark: ProductMark,
  options: { readonly large?: boolean; readonly dashed?: boolean } = {}
) =>
  `<span class="im${typeof mark !== "string" && "logo" in mark ? " im-logo" : ""}${options.large === true ? " im-lg" : ""}${options.dashed === true ? " im-dashed" : ""}" aria-hidden="true">${
    typeof mark === "string"
      ? escapeHtml(mark)
      : "logo" in mark
        ? productLogo(mark.logo)
        : icon(mark.icon)
  }</span>`;
