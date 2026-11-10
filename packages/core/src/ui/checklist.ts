import { escapeAttribute, escapeHtml } from "../escape.js";

/** One box of a `checklist`. */
export interface CheckItem {
  readonly value: string;
  /** What the box chooses: its accessible name. */
  readonly label: string;
  /** One line about it, read as the box's description. */
  readonly description?: string;
  readonly checked?: boolean;
  /** Listed but not choosable now, such as a retired patch among live ones. */
  readonly disabled?: boolean;
}

/**
 * Checkboxes of one group as rows in a box, each with its name and a line about it, under a
 * legend, with an optional hint and error in the field order. For choosing some of a list, such
 * as which of someone's patches to retire; `choiceGroup` holds a few short choices side by side.
 * A refused group starts the page's focus on its first box that can be chosen, or on its error
 * when none can. `id` must be unique on the page and seeds each box's ids.
 */
export const checklist = (spec: {
  readonly id: string;
  readonly legend: string;
  readonly name: string;
  readonly items: ReadonlyArray<CheckItem>;
  readonly hint?: string;
  /** The refusal for the group after a submit, in Patchy's words. */
  readonly error?: string;
}) => {
  const hintId = `${spec.id}-hint`;
  const errorId = `${spec.id}-error`;
  const group = [
    spec.hint === undefined ? undefined : hintId,
    spec.error === undefined ? undefined : errorId
  ].filter((id) => id !== undefined);
  const invalid = spec.error === undefined ? "" : ' aria-invalid="true"';
  const first =
    spec.error === undefined ? -1 : spec.items.findIndex((item) => item.disabled !== true);
  const items = spec.items
    .map((item, index) => {
      const descriptionId = `${spec.id}-${index}-description`;
      const describedBy = [
        ...(item.description === undefined ? [] : [descriptionId]),
        ...group
      ].join(" ");
      return `<label class="row checkrow"><input class="field-checkbox" type="checkbox" name="${escapeAttribute(spec.name)}" value="${escapeAttribute(item.value)}"${item.checked === true ? " checked" : ""}${item.disabled === true ? " disabled" : ""}${describedBy === "" ? "" : ` aria-describedby="${escapeAttribute(describedBy)}"`}${invalid}${index === first ? " autofocus" : ""}><span class="row-main"><span class="row-name">${escapeHtml(item.label)}</span>${item.description === undefined ? "" : `<span class="row-desc" id="${escapeAttribute(descriptionId)}">${escapeHtml(item.description)}</span>`}</span></label>`;
    })
    .join("");
  return `<fieldset class="fieldset" id="${escapeAttribute(spec.id)}"${invalid}><legend class="field-label">${escapeHtml(spec.legend)}</legend>${spec.hint === undefined ? "" : `<p class="field-hint" id="${escapeAttribute(hintId)}">${escapeHtml(spec.hint)}</p>`}<div class="rows box checklist">${items}</div>${spec.error === undefined ? "" : `<p class="field-error" id="${escapeAttribute(errorId)}"${first === -1 ? ' tabindex="-1" autofocus' : ""}>${escapeHtml(spec.error)}</p>`}</fieldset>`;
};
