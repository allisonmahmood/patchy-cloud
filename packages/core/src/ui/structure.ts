import { menuCopy, menuLink, menuPost, rowMenu } from "../components.js";
import { escapeAttribute, escapeHtml } from "../escape.js";
import { iconButton } from "./controls.js";
import { icon } from "./icons.js";

/**
 * An id for one of a list's repeated parts, such as a row's menu, from what names the row: its
 * immutable key, never its title. Letters and digits stay as they are; anything else becomes
 * `_<hex>_` and parts join with `-`, so different keys always make different ids.
 */
export const idFor = (...parts: ReadonlyArray<string>) =>
  parts
    .map((part) =>
      part === ""
        ? "~"
        : Array.from(part, (char) =>
            /^[A-Za-z0-9]$/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`
          ).join("")
    )
    .join("-");

/** A link up to the page this one belongs to: "← All patches". */
export interface Parent {
  readonly label: string;
  readonly href: string;
}

const parentLink = (parent: Parent) =>
  `<a class="ph-parent" href="${escapeAttribute(parent.href)}">${icon("back")}${escapeHtml(parent.label)}</a>`;

/**
 * A page's header: parent link, mark, the one `h1`, a meta line, an optional status line and the
 * page's actions. `mark`, `meta`, `status` and `actions` are trusted HTML; `meta` items are joined
 * with a middle dot.
 */
export const pageHeader = (spec: {
  readonly parent?: Parent;
  readonly mark?: string;
  readonly title: string;
  readonly meta?: ReadonlyArray<string>;
  readonly status?: string;
  readonly actions?: string;
}) =>
  `<header class="ph">${spec.parent === undefined ? "" : parentLink(spec.parent)}<div class="ph-row${spec.mark === undefined ? " ph-row-nomark" : ""}">${spec.mark === undefined ? "" : `<div class="ph-mark">${spec.mark}</div>`}<div class="ph-text"><h1 class="title">${escapeHtml(spec.title)}</h1>${spec.meta === undefined || spec.meta.length === 0 ? "" : `<p class="ph-meta">${spec.meta.join('<span class="ph-sep" aria-hidden="true">·</span>')}</p>`}${spec.status === undefined ? "" : `<div class="ph-status">${spec.status}</div>`}</div>${spec.actions === undefined ? "" : `<div class="ph-actions">${spec.actions}</div>`}</div></header>`;

/** A section: a title, an optional one-line description and an action, then its content. */
export const section = (spec: {
  readonly title?: string;
  readonly description?: string;
  /** Trusted HTML, at the section head's end. */
  readonly action?: string;
  /** Trusted HTML. */
  readonly body: string;
  readonly id?: string;
}) =>
  `<section class="section"${spec.id === undefined ? "" : ` id="${escapeAttribute(spec.id)}"`}>${spec.title === undefined && spec.action === undefined ? "" : `<div class="section-head"><div>${spec.title === undefined ? "" : `<h2 class="section-title">${escapeHtml(spec.title)}</h2>`}${spec.description === undefined ? "" : `<p class="meta">${escapeHtml(spec.description)}</p>`}</div>${spec.action ?? ""}</div>`}${spec.body}</section>`;

/** One setting: what it is on the left, its control (or its value, read-only) on the right. */
export const settingRow = (spec: {
  readonly title: string;
  readonly description?: string;
  /** Trusted HTML: a switch form, a button, or the value as text for someone who can't change it. */
  readonly control: string;
}) =>
  `<div class="row setting"><div class="row-main"><span class="row-name">${escapeHtml(spec.title)}</span>${spec.description === undefined ? "" : `<span class="row-desc">${escapeHtml(spec.description)}</span>`}</div><div class="row-end">${spec.control}</div></div>`;

/**
 * A card of the Settings template: a title, its setting rows or body, and a footer, usually the
 * card's own Save. `danger` draws the danger zone, last on the page. A card that is one form
 * gives `form`, and its rows and footer post together.
 */
export const card = (spec: {
  readonly title?: string;
  readonly description?: string;
  readonly rows?: ReadonlyArray<string>;
  readonly body?: string;
  readonly foot?: string;
  readonly danger?: boolean;
  readonly form?: { readonly action: string; readonly fields?: string };
}) => {
  const inner = `${spec.title === undefined ? "" : `<div class="card-head"><h2 class="section-title">${escapeHtml(spec.title)}</h2>${spec.description === undefined ? "" : `<p class="meta">${escapeHtml(spec.description)}</p>`}</div>`}${spec.body === undefined ? "" : `<div class="card-body">${spec.body}</div>`}${spec.rows === undefined ? "" : `<div class="rows">${spec.rows.join("")}</div>`}${spec.foot === undefined ? "" : `<div class="card-foot">${spec.foot}</div>`}`;
  const className = `card${spec.danger === true ? " card-danger" : ""}`;
  return spec.form === undefined
    ? `<section class="${className}">${inner}</section>`
    : `<form class="${className}" method="post" action="${escapeAttribute(spec.form.action)}">${spec.form.fields ?? ""}${inner}</form>`;
};

/** Labels and values, such as a patch's owner and version. Values are trusted HTML. */
export const facts = (pairs: ReadonlyArray<readonly [label: string, value: string]>) =>
  `<dl class="facts">${pairs.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join("")}</dl>`;

/**
 * One thing in a list: a mark, its name and one line, and what you can do at its end. With
 * `href` the whole row opens it, while its own buttons and menu stay pressable above the link.
 */
export const row = (spec: {
  readonly lead?: string;
  readonly name: string;
  readonly href?: string;
  readonly description?: string;
  readonly end?: string;
}) =>
  `<div class="row${spec.lead === undefined ? " row-plain" : ""}">${spec.lead ?? ""}<div class="row-main"><span class="row-name">${spec.href === undefined ? escapeHtml(spec.name) : `<a class="row-link" href="${escapeAttribute(spec.href)}">${escapeHtml(spec.name)}</a>`}</span>${spec.description === undefined ? "" : `<span class="row-desc">${escapeHtml(spec.description)}</span>`}</div><div class="row-end">${spec.end ?? ""}</div></div>`;

/** Rows on hairlines, in a box when `boxed`. Items are `row` or `settingRow` output. */
export const rows = (items: ReadonlyArray<string>, boxed = false) =>
  `<div class="rows${boxed ? " box" : ""}">${items.join("")}</div>`;

/** A table column: its header and how its cells sit. */
export interface Column {
  readonly label: string;
  /** Numbers and actions sit at the end. */
  readonly align?: "start" | "end";
  /** Left out on a phone, where the row keeps what matters. */
  readonly hideOnPhone?: boolean;
  /** For a column of one control, such as a row's menu, with no visible header. */
  readonly hidden?: boolean;
  /** Keeps its cells on one line, such as a time, a count or a button, so another column wraps. */
  readonly nowrap?: boolean;
  /**
   * Takes the room the other columns leave, such as a patch's name: its `row-desc` line stays one
   * line, cut with an ellipsis.
   */
  readonly grow?: boolean;
  /**
   * Holds a short sentence, such as why a patch needs attention or a state and its detail, which
   * the growing column never squeezes below a readable line; on a phone the table scrolls.
   */
  readonly readable?: boolean;
}

/**
 * A table for comparing columns, in a wrapper that scrolls on a phone. Cells are trusted HTML;
 * a row whose first cell holds a `row-link` opens on a press anywhere in it.
 */
export const table = (spec: {
  /** What the table lists, for assistive tech. */
  readonly label: string;
  readonly columns: ReadonlyArray<Column>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}) => {
  const cellClass = (column: Column | undefined) =>
    [
      column?.align === "end" ? "r" : "",
      column?.hideOnPhone === true ? "hide-sm" : "",
      column?.nowrap === true ? "nowrap" : "",
      column?.grow === true ? "cell-grow" : "",
      column?.readable === true ? "cell-readable" : ""
    ]
      .filter((name) => name !== "")
      .join(" ");
  const classAttribute = (column: Column | undefined) => {
    const name = cellClass(column);
    return name === "" ? "" : ` class="${name}"`;
  };
  return `<div class="table-wrap"><table class="table" aria-label="${escapeAttribute(spec.label)}"><thead><tr>${spec.columns
    .map(
      (column) =>
        `<th scope="col"${classAttribute(column)}>${column.hidden === true ? `<span class="sr-only">${escapeHtml(column.label)}</span>` : escapeHtml(column.label)}</th>`
    )
    .join("")}</tr></thead><tbody>${spec.rows
    .map(
      (cells) =>
        `<tr>${cells.map((cell, index) => `<td${classAttribute(spec.columns[index])}>${cell}</td>`).join("")}</tr>`
    )
    .join("")}</tbody></table></div>`;
};

/** A link with a count, for tabs and filters. */
export interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly count?: number;
}

const navLink = (item: NavItem, current: string, className: string) =>
  `<a${className === "" ? "" : ` class="${className}"`} href="${escapeAttribute(item.href)}"${item.label === current ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}${item.count === undefined ? "" : `<span class="count">${item.count}</span>`}</a>`;

/** Underline tabs between an object's pages: Overview, Log, Versions, Settings. */
export const tabs = (spec: {
  readonly label: string;
  readonly items: ReadonlyArray<NavItem>;
  readonly current: string;
}) =>
  `<nav class="tabs" aria-label="${escapeAttribute(spec.label)}">${spec.items.map((item) => navLink(item, spec.current, "tab")).join("")}</nav>`;

/** A segmented filter over a list: All · Tools · Pages · Yours. Each choice is a URL. */
export const segmented = (spec: {
  readonly label: string;
  readonly items: ReadonlyArray<NavItem>;
  readonly current: string;
}) =>
  `<nav class="seg" aria-label="${escapeAttribute(spec.label)}">${spec.items.map((item) => navLink(item, spec.current, "")).join("")}</nav>`;

/** A filter chip, such as a log's Outcome: Failed; `on` while it narrows the list. */
export const chip = (spec: {
  readonly key?: string;
  readonly value: string;
  readonly href: string;
  readonly on?: boolean;
}) =>
  `<a class="chip${spec.on === true ? " chip-on" : ""}" href="${escapeAttribute(spec.href)}"${spec.on === true ? ' aria-current="true"' : ""}>${spec.key === undefined ? "" : `<span class="chip-key">${escapeHtml(spec.key)}</span>`}${escapeHtml(spec.value)}${spec.on === true ? icon("close") : icon("chevron")}</a>`;

/** One item of a `menu`. */
export type MenuItem =
  | {
      readonly kind: "link";
      readonly label: string;
      readonly href: string;
      readonly danger?: boolean;
    }
  | {
      readonly kind: "post";
      readonly label: string;
      readonly action: string;
      /** Trusted HTML, usually hidden inputs. */
      readonly fields?: string;
      readonly danger?: boolean;
    }
  | { readonly kind: "copy"; readonly label: string; readonly text: string }
  | { readonly kind: "rule" };

/**
 * A row's actions behind a quiet ⋯ button: a native popover of links and buttons, not an ARIA
 * menu. `id` names the row and must be unique on the page (see `idFor`); `label` names whose
 * actions they are.
 */
export const menu = (spec: {
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<MenuItem>;
}) =>
  rowMenu(
    spec.id,
    spec.label,
    spec.items.map((item) => {
      switch (item.kind) {
        case "link":
          return menuLink(item.href, item.label, item.danger === true, spec.label);
        case "post":
          return menuPost(
            item.action,
            item.label,
            item.fields ?? "",
            item.danger === true,
            spec.label
          );
        case "copy":
          return menuCopy(item.text, item.label, spec.label);
        case "rule":
          return '<hr class="menu-rule">';
      }
    })
  );

/**
 * A dialog: a URL rendered over its page, for `AppShell.overlay`, which makes the page behind it
 * inert. Close and Escape go back to the page; a dialog nobody may dismiss but by its own
 * actions, such as the Final step's Later, leaves out `closeHref`. Give its first field or, for a
 * destructive one, its Cancel `autofocus`. `body` and `foot` are trusted HTML.
 */
export const dialog = (spec: {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly foot?: string;
  readonly closeHref?: string;
  readonly mark?: string;
  readonly size?: "md" | "lg";
  /** The dialog is one form: its body and foot post together. A refusal draws it again. */
  readonly form?: { readonly action: string; readonly fields?: string };
}) => {
  const inner = `<div class="dialog-body">${spec.body}</div>${spec.foot === undefined ? "" : `<div class="dialog-foot">${spec.foot}</div>`}`;
  return `<section class="dialog${spec.size === "lg" ? " dialog-md" : ""}" id="${escapeAttribute(spec.id)}" role="dialog" aria-modal="true" aria-labelledby="${escapeAttribute(`${spec.id}-title`)}" data-dialog${spec.closeHref === undefined ? "" : ` data-close="${escapeAttribute(spec.closeHref)}"`}><div class="dialog-head">${spec.mark ?? ""}<h2 id="${escapeAttribute(`${spec.id}-title`)}">${escapeHtml(spec.title)}</h2>${spec.closeHref === undefined ? "" : iconButton("Close", "close", { href: spec.closeHref })}</div>${spec.form === undefined ? inner : `<form method="post" action="${escapeAttribute(spec.form.action)}" novalidate>${spec.form.fields ?? ""}${inner}</form>`}</section>`;
};

/** A setup step: done, current or still to come. */
export interface Step {
  readonly title: string;
  /** Trusted HTML under the title. */
  readonly body?: string;
  readonly state: "done" | "current" | "later";
}

/** Numbered setup steps, at most three: numbers in circles, no connecting lines. */
export const steps = (items: ReadonlyArray<Step>) =>
  `<ol class="steps">${items
    .map(
      (step, index) =>
        `<li class="step${step.state === "later" ? "" : ` step-${step.state}`}"${step.state === "current" ? ' aria-current="step"' : ""}><span class="step-marker" aria-hidden="true">${step.state === "done" ? icon("check") : index + 1}</span><div><p class="step-title">${escapeHtml(step.title)}</p>${step.body ?? ""}</div></li>`
    )
    .join("")}</ol>`;
