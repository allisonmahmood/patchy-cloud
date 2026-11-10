import { escapeAttribute, escapeHtml } from "./escape.js";

/**
 * The command list's markup: a search field over a listbox of rows to go to, the `command`
 * classes in `servedStyles`. The switcher renders it in the browser, so it depends only on
 * escaping. Text is escaped here; marks and keycap glyphs are trusted markup.
 *
 * It is an APG combobox: the field's input keeps focus, `aria-activedescendant` names the lit
 * row, and rows are links drawn as options, so a click follows them and a modified click opens a
 * new tab, while Tab never stops on one.
 */

const enterGlyph =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 5v6.5a3.5 3.5 0 0 1-3.5 3.5H5"/><path d="m9.5 10.5-4.5 4.5 4.5 4.5"/></svg>';

/**
 * A keycap around trusted markup, such as a drawn glyph. It shows the key, so assistive tech
 * skips it; whatever it acts on names itself.
 */
export const kbd = (glyph: string, small = false) =>
  `<kbd class="kbd${small ? " kbd-sm" : ""}" aria-hidden="true">${glyph}</kbd>`;

/** The lit row's ↵. */
export const enterKey = kbd(enterGlyph, true);

/** One row of a command list. */
export interface CommandRow {
  /** Unique on the page: the field names the lit row by it. */
  readonly id: string;
  readonly href: string;
  /** Trusted markup: a patch's mark, or a `command-icon`. */
  readonly mark: string;
  readonly title: string;
  /** One quiet fact at the row's end, such as when it was last opened. */
  readonly detail?: string | undefined;
  /** A What's new dot after the title, named this for assistive tech. */
  readonly dot?: string | undefined;
}

/** A row; the lit one carries the ↵ keycap. */
export const commandRow = (row: CommandRow, lit = false) =>
  `<a class="command-row" role="option" id="${escapeAttribute(row.id)}" href="${escapeAttribute(row.href)}" tabindex="-1" aria-selected="${lit}">${row.mark}<span class="command-title">${escapeHtml(row.title)}${row.dot === undefined ? "" : `<span class="whats-new-dot" role="img" aria-label="${escapeAttribute(row.dot)}"></span>`}</span>${row.detail ? `<span class="command-detail">${escapeHtml(row.detail)}</span>` : ""}${lit ? enterKey : ""}</a>`;

/** An icon as a row's mark: trusted SVG at the mark's footprint. */
export const commandIcon = (svg: string) =>
  `<span class="command-icon" aria-hidden="true">${svg}</span>`;

/**
 * Rows under a label, which names the group for assistive tech. `patchy` leads the label with
 * Patchy's glyph, for Patchy's own places. `id` must be unique on the page.
 */
export const commandGroup = (input: {
  readonly id: string;
  readonly label: string;
  readonly rows: string;
  readonly patchy?: boolean;
}) =>
  `<div class="command-group" role="group" aria-labelledby="${escapeAttribute(input.id)}"><p class="shelf-label command-head${input.patchy ? " command-head-patchy" : ""}" id="${escapeAttribute(input.id)}" role="presentation">${input.patchy ? '<span class="glyph glyph-sm" aria-hidden="true"></span>' : ""}${escapeHtml(input.label)}</p>${input.rows}</div>`;

/**
 * The whole list: the field, a label so a click anywhere on it, glyph included, lands in its
 * input, the line that says nothing matched, empty until something doesn't, and the listbox
 * holding `rows`. `id` seeds the listbox's and the status line's ids.
 */
export const commandList = (input: {
  readonly id: string;
  /** The field's and the listbox's accessible name. */
  readonly label: string;
  readonly placeholder: string;
  readonly rows: string;
}) =>
  `<div class="command"><label class="field field-group command-field"><span class="glyph glyph-sm" aria-hidden="true"></span><input type="text" role="combobox" aria-label="${escapeAttribute(input.label)}" aria-expanded="true" aria-controls="${escapeAttribute(input.id)}" aria-autocomplete="list" placeholder="${escapeAttribute(input.placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></label><p class="command-empty" id="${escapeAttribute(`${input.id}-empty`)}" role="status"></p><div class="command-list" id="${escapeAttribute(input.id)}" role="listbox" aria-label="${escapeAttribute(input.label)}">${input.rows}</div></div>`;
