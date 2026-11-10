import { avatar } from "../components.js";
import { escapeAttribute, escapeHtml } from "../escape.js";
import { notice } from "./feedback.js";
import { icon } from "./icons.js";
import type { Column } from "./structure.js";

/**
 * Parts a Detail page's tabs need beyond the shared structure: a filter chip that opens a menu
 * of links, a table grouped under headings whose rows expand, the Settings template drawn inside
 * a tab, an address's Copy button, the menu items a header's ⋯ adds, a refusal that takes focus,
 * a person with their mark, and a row named by something typed. A patch's page uses them; a
 * connection's can.
 */

/** One choice of a `chipMenu`: a link, `current` while it is the filter's value. */
export interface ChipChoice {
  readonly label: string;
  readonly href: string;
  readonly current?: boolean;
}

/**
 * A filter chip that opens a native popover of links, one per value, so the filter works
 * without script and the URL holds it: Outcome · Any. `on` while it narrows the list. `id` must
 * be unique on the page.
 */
export const chipMenu = (spec: {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly on?: boolean;
  readonly choices: ReadonlyArray<ChipChoice>;
}) =>
  `<button class="chip chip-menu${spec.on === true ? " chip-on" : ""}" type="button" popovertarget="${escapeAttribute(`menu-${spec.id}`)}"><span class="chip-key">${escapeHtml(spec.key)}</span>${escapeHtml(spec.value)}${icon("chevron")}</button><div class="menu" id="${escapeAttribute(`menu-${spec.id}`)}" popover aria-label="${escapeAttribute(spec.key)}">${spec.choices
    .map(
      (choice) =>
        `<a class="menu-item" href="${escapeAttribute(choice.href)}"${choice.current === true ? ' aria-current="true"' : ""}>${escapeHtml(choice.label)}</a>`
    )
    .join("")}</div>`;

/** One row of a `groupedTable`: its cells, an `id` for a permalink, and what it expands to. */
export interface GroupedRow {
  readonly cells: ReadonlyArray<string>;
  /** Names the row for a permalink; with `expand`, it names the disclosure, which a fragment opens. */
  readonly id?: string;
  /** The row's disclosure: a summary and what opens under it, in one full-width cell below. */
  readonly expand?: {
    readonly summary: string;
    /** Trusted HTML. */
    readonly body: string;
    readonly open?: boolean;
  };
}

/**
 * A table whose rows sit under group headings, such as a log's days, each row optionally
 * expanding in place. Cells are trusted HTML; `compact` rows are 40px. Its rows keep their cells
 * on one line, so on a phone it scrolls in its own wrapper rather than breaking words.
 */
export const groupedTable = (spec: {
  readonly label: string;
  readonly columns: ReadonlyArray<Column>;
  readonly groups: ReadonlyArray<{
    readonly label: string;
    readonly rows: ReadonlyArray<GroupedRow>;
  }>;
  readonly compact?: boolean;
}) => {
  const classOf = (column: Column | undefined) => {
    const name = [column?.align === "end" ? "r" : "", column?.hideOnPhone === true ? "hide-sm" : ""]
      .filter((part) => part !== "")
      .join(" ");
    return name === "" ? "" : ` class="${name}"`;
  };
  const span = spec.columns.length;
  const row = (item: GroupedRow) => {
    const id =
      item.id === undefined || item.expand !== undefined ? "" : ` id="${escapeAttribute(item.id)}"`;
    const cells = `<tr${id}>${item.cells.map((cell, index) => `<td${classOf(spec.columns[index])}>${cell}</td>`).join("")}</tr>`;
    if (item.expand === undefined) return cells;
    const detailsId = item.id === undefined ? "" : ` id="${escapeAttribute(item.id)}"`;
    return `${cells}<tr class="table-expand"><td colspan="${span}"><details${detailsId}${item.expand.open === true ? " open" : ""}><summary>${escapeHtml(item.expand.summary)}</summary>${item.expand.body}</details></td></tr>`;
  };
  // Each group is its own row group, its heading a header cell for the rows under it.
  return `<div class="table-wrap"><table class="table table-grouped${spec.compact === true ? " table-compact" : ""}" aria-label="${escapeAttribute(spec.label)}"><thead><tr>${spec.columns
    .map(
      (column) =>
        `<th scope="col"${classOf(column)}>${column.hidden === true ? `<span class="sr-only">${escapeHtml(column.label)}</span>` : escapeHtml(column.label)}</th>`
    )
    .join("")}</tr></thead>${spec.groups
    .map(
      (group) =>
        `<tbody><tr class="group-row"><th scope="rowgroup" colspan="${span}">${escapeHtml(group.label)}</th></tr>${group.rows.map(row).join("")}</tbody>`
    )
    .join("")}</table></div>`;
};

/**
 * The Settings template inside a Detail page's tab, under the object's own header: its cards at
 * the settings width, each its own form, and the danger zone set apart last.
 */
export const settingsPanel = (spec: {
  /** `card` output, in order. */
  readonly cards: ReadonlyArray<string>;
  /** A `card` with `danger`. */
  readonly danger?: string;
}) =>
  `<div class="settings-panel">${spec.cards.join("")}${spec.danger === undefined ? "" : `<div class="card-gap">${spec.danger}</div>`}</div>`;

/** A menu item that opens `href` in a new tab; `target` names whose it is. */
export const menuNewTab = (href: string, target: string) =>
  `<a class="menu-item" href="${escapeAttribute(href)}" target="_blank" rel="noopener" aria-label="${escapeAttribute(`Open in a new tab, ${target}`)}">Open in a new tab</a>`;

/** The rule between a menu's everyday items and its destructive ones. */
export const menuRule = '<hr class="menu-rule">';

/**
 * A refusal not tied to one field: a danger notice that takes focus when its page or dialog
 * opens, so it is read before anything else on it.
 */
export const refusalNotice = (text: string) =>
  `<div class="refusal" tabindex="-1" autofocus>${notice({ tone: "danger", title: text })}</div>`;

/** A person by name with their small mark, as owners, publishers and callers appear in a list. */
export const person = (key: string, name: string) =>
  `<span class="person">${avatar(key, name).replace('class="avatar', 'class="avatar av-sm')}${escapeHtml(name)}</span>`;

/**
 * A row whose name is something literally typed, such as an agent tool's name, set in Geist Mono:
 * `row` otherwise, its description and end beside it.
 */
export const codeRow = (spec: {
  readonly name: string;
  readonly description?: string;
  /** Trusted HTML. */
  readonly end?: string;
}) =>
  `<div class="row row-plain"><div class="row-main"><span class="row-name code">${escapeHtml(spec.name)}</span>${spec.description === undefined ? "" : `<span class="row-desc">${escapeHtml(spec.description)}</span>`}</div><div class="row-end">${spec.end ?? ""}</div></div>`;
