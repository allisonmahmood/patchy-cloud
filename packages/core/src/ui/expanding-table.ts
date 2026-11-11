import { escapeAttribute, escapeHtml } from "../escape.js";
import type { Column } from "./structure.js";

/** One row of an `expandingTable`: its cells, and what opens under it. */
export interface ExpandingRow {
  /** Trusted HTML, one per column. */
  readonly cells: ReadonlyArray<string>;
  /** A disclosure under the row, across every column: its summary text and trusted HTML body. */
  readonly detail?: { readonly summary: string; readonly body: string };
}

const cellClass = (column: Column | undefined) => {
  const names = [column?.align === "end" ? "r" : "", column?.hideOnPhone === true ? "hide-sm" : ""]
    .filter((name) => name !== "")
    .join(" ");
  return names === "" ? "" : ` class="${names}"`;
};

/**
 * A table whose rows each open to more, such as a call's ids and query: the row, then a row
 * across every column holding a native disclosure, read as one. Otherwise as `table`: named for
 * assistive tech, scrolling in its wrapper on a phone, columns aligned and hidden the same way.
 * `compact` is the 40px row of a log; `wide` keeps its columns whole, scrolling on a phone.
 */
export const expandingTable = (spec: {
  readonly label: string;
  readonly columns: ReadonlyArray<Column>;
  readonly rows: ReadonlyArray<ExpandingRow>;
  readonly compact?: boolean;
  readonly wide?: boolean;
}) =>
  `<div class="table-wrap"><table class="table${spec.compact === true ? " table-compact" : ""}${spec.wide === true ? " table-wide" : ""}" aria-label="${escapeAttribute(spec.label)}"><thead><tr>${spec.columns
    .map(
      (column) =>
        `<th scope="col"${cellClass(column)}>${column.hidden === true ? `<span class="sr-only">${escapeHtml(column.label)}</span>` : escapeHtml(column.label)}</th>`
    )
    .join("")}</tr></thead><tbody>${spec.rows
    .map(
      (row) =>
        `<tr>${row.cells.map((cell, index) => `<td${cellClass(spec.columns[index])}>${cell}</td>`).join("")}</tr>${row.detail === undefined ? "" : `<tr class="table-expand"><td colspan="${spec.columns.length}"><details><summary>${escapeHtml(row.detail.summary)}</summary>${row.detail.body}</details></td></tr>`}`
    )
    .join("")}</tbody></table></div>`;
