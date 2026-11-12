import { escapeHtml } from "../escape.js";

/** "Add 3, remove 1", or one of them alone; empty when nothing changed. */
const changeSummary = (added: number, removed: number) =>
  [added > 0 ? `Add ${added}` : "", removed > 0 ? `${added > 0 ? "r" : "R"}emove ${removed}` : ""]
    .filter((part) => part !== "")
    .join(", ");

/**
 * A form's unsaved changes to a saved selection, stuck to the bottom of the form while it scrolls:
 * "Add 3, remove 1", then its actions, such as Discard and Review…. With script it counts the
 * form's `checklist` boxes that differ from their saved state live, plus `added` and `removed`
 * that no box on the page shows, such as ticks kept across a search, and it hides while nothing
 * changed. Without script it says what the page was drawn with and always offers its actions.
 * `actions` is trusted HTML.
 */
export const changeBar = (spec: {
  /** Every change the page was drawn with, shown or not. */
  readonly added: number;
  readonly removed: number;
  /** The changes no box on the page shows, which the live count starts from. */
  readonly offPage: { readonly added: number; readonly removed: number };
  readonly actions: string;
}) =>
  `<div class="change-bar" data-change-bar data-added="${spec.offPage.added}" data-removed="${spec.offPage.removed}"><p class="change-bar-summary" aria-live="polite">${escapeHtml(changeSummary(spec.added, spec.removed))}</p><div class="btn-group">${spec.actions}</div></div>`;
