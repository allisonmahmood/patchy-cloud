import { escapeAttribute, escapeHtml } from "../escape.js";
import { pageHeader, type Parent } from "./structure.js";

/**
 * Every first-party page is one of five templates. Each fills slots and takes no CSS; what a
 * page needs that a slot can't hold becomes a component variant or is cut.
 *
 * A template returns the `heading` and `body` that `pageResponse` takes, so a page spreads it in:
 * `pageResponse({ title, app, ...indexPage({ … }) })`. App templates draw their own header, so
 * their `heading` is empty; the door's is its kicker and title, under the door's brand.
 */
export interface Template {
  readonly heading: string;
  readonly body: string;
}

/** The header slots every app template shares. Marks, meta items, status and actions are trusted HTML. */
interface Header {
  readonly title: string;
  readonly meta?: ReadonlyArray<string>;
  readonly status?: string;
  /** The region's one primary action, and at most a few secondary ones. */
  readonly actions?: string;
}

const page = (width: "index" | "settings" | "flow", content: string): Template => ({
  heading: "",
  body: `<div class="page${width === "index" ? "" : ` page-${width}`}">${content}</div>`
});

/**
 * Index: a list of things. Header, then a toolbar (a segmented filter, then search or chips),
 * then the table or rows, or the empty state in their place, then pagination. Home, All patches,
 * People, Integrations, Your agents, What's new.
 */
export const indexPage = (
  spec: Header & {
    readonly toolbar?: string;
    readonly content: string;
    readonly pagination?: string;
  }
) =>
  page(
    "index",
    `${pageHeader(spec)}${spec.toolbar === undefined ? "" : `<div class="toolbar">${spec.toolbar}</div>`}${spec.content}${spec.pagination === undefined ? "" : `<nav class="pagination" aria-label="Pages">${spec.pagination}</nav>`}`
  );

/**
 * Detail: one object. A parent link, the header with the object's mark, its tabs, then the main
 * column with an aside beside it, below it on a narrow page. A patch, a connection.
 */
export const detailPage = (
  spec: Header & {
    readonly parent: Parent;
    readonly mark: string;
    readonly tabs?: string;
    readonly main: string;
    readonly aside?: string;
  }
) =>
  page(
    "index",
    `${pageHeader(spec)}${spec.tabs ?? ""}${spec.aside === undefined ? spec.main : `<div class="split"><div class="split-main">${spec.main}</div><aside class="aside">${spec.aside}</aside></div>`}`
  );

/**
 * Settings: cards of setting rows, each card its own form with its own Save, and the danger
 * zone last. Agent access, a patch's Settings, a connection's Settings.
 */
export const settingsPage = (
  spec: Header & {
    readonly parent?: Parent;
    /** `card` output, in order. */
    readonly cards: ReadonlyArray<string>;
    /** A `card` with `danger`, set apart at the end. */
    readonly danger?: string;
  }
) =>
  page(
    "settings",
    `${pageHeader(spec)}${spec.cards.join("")}${spec.danger === undefined ? "" : `<div class="card-gap">${spec.danger}</div>`}`
  );

/** One numbered part of a flow, in the order the task goes. */
export interface FlowSection {
  readonly title: string;
  /** Trusted HTML. */
  readonly body: string;
  /** Still to come, until an earlier part is done: its controls are disabled, so they neither take focus nor submit. */
  readonly locked?: boolean;
}

/**
 * Flow: a task in numbered sections, then what happens once it is done, then its primary action
 * and Cancel. With `form`, the sections and actions post together. Connect an integration,
 * connect an app, add a computer.
 */
export const flowPage = (
  spec: Header & {
    readonly parent: Parent;
    readonly mark?: string;
    readonly sections: ReadonlyArray<FlowSection>;
    /** Trusted HTML after the sections, such as the can and can't list once connected. */
    readonly outcome?: string;
    /** Trusted HTML: the primary action and Cancel. */
    readonly submit: string;
    readonly form?: { readonly action: string; readonly fields?: string };
  }
) => {
  const sections = spec.sections
    .map(
      (part, index) =>
        `<fieldset class="flow-section"${part.locked === true ? " disabled" : ""}><legend class="flow-title"><span class="flow-number">${index + 1}</span>${escapeHtml(part.title)}</legend>${part.body}</fieldset>`
    )
    .join("");
  const content = `<div class="flow">${sections}${spec.outcome ?? ""}<div class="btn-group">${spec.submit}</div></div>`;
  return page(
    "flow",
    `${pageHeader(spec)}${spec.form === undefined ? content : `<form method="post" action="${escapeAttribute(spec.form.action)}" novalidate>${spec.form.fields ?? ""}${content}</form>`}`
  );
};

/**
 * Door: one card on the grid canvas, for signing in, joining, device login, consent and
 * Patchy's notices. A kicker, the title, its body, one primary and at most a quiet secondary, and
 * a foot such as Not you. The brand and the card are `pageResponse`'s, around these.
 */
export const doorPage = (spec: {
  readonly kicker?: string;
  readonly title: string;
  /** Trusted HTML. */
  readonly body: string;
  /** Trusted HTML: the one primary, then a quiet secondary. */
  readonly actions?: string;
  /** Trusted HTML, set apart under a rule. */
  readonly foot?: string;
}): Template => ({
  heading: `${spec.kicker === undefined ? "" : `<p class="kicker">${escapeHtml(spec.kicker)}</p>`}<h1 class="page-heading">${escapeHtml(spec.title)}</h1>`,
  body: `<div class="door-body">${spec.body}</div>${spec.actions === undefined ? "" : `<div class="actions">${spec.actions}</div>`}${spec.foot === undefined ? "" : `<div class="door-foot">${spec.foot}</div>`}`
});
