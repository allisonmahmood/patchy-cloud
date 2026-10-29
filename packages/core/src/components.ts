import { escapeAttribute, escapeHtml } from "./html.js";
import { isPage } from "./patch-presentation.js";

/** Picks one of `choices` from a key, so the same person or patch always gets the same one. */
const pick = <T>(key: string, choices: readonly [T, ...T[]]): T =>
  choices[Array.from(key).reduce((sum, char) => sum + char.charCodeAt(0), 0) % choices.length]!;

/** A person's initials, tinted from `key`; `waiting` dashes an invitation and `off` mutes a deactivated user. */
export const avatar = (key: string, label: string, variant?: "waiting" | "off") => {
  const words = label.trim().split(/\s+/);
  const picked = words.length > 1 ? [words[0], words.at(-1)] : [words[0]];
  const letters = picked.map((word) => Array.from(word ?? "")[0]?.toUpperCase() ?? "").join("");
  const tint =
    variant === undefined
      ? pick(key, ["", " avatar-green", " avatar-amber"])
      : ` avatar-${variant}`;
  return `<span class="avatar${tint}" aria-hidden="true">${escapeHtml(letters)}</span>`;
};

/** The guide's agent icon: a terminal window. */
export const agentIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15H17" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** An agent's mark beside its name, as `avatar` is a person's. */
export const agentMark = `<span class="agent-mark" aria-hidden="true">${agentIcon}</span>`;

/** Two letters from `name` on a tint picked from it. `large` is the size beside a page heading. */
export const monogram = (name: string, large = false) => {
  const words = name.split("-").filter((word) => word !== "");
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2);
  const tint = pick(name, ["", " mono-blue", " mono-green", " mono-amber", " mono-pink"]);
  return `<span class="mono${tint}${large ? " mono-lg" : ""}" aria-hidden="true">${escapeHtml(letters.toUpperCase())}</span>`;
};

/** A patch's mark: a ruled sheet for a page, else its monogram. */
export const patchMark = (name: string, tier: number, large = false) =>
  isPage({ tier })
    ? `<span class="page-mark${large ? " page-mark-lg" : ""}" aria-hidden="true"></span>`
    : monogram(name, large);

const dots =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const searchIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5" stroke-linecap="round"/></svg>';

/** One row's actions behind a quiet button. The popover's id is the row's own, so ids must be unique on the page. */
export const rowMenu = (id: string, label: string, items: readonly string[]) =>
  `<button class="btn btn-quiet btn-icon" type="button" popovertarget="${escapeAttribute(`menu-${id}`)}" aria-label="${escapeAttribute(`Actions for ${label}`)}">${dots}</button><div class="menu" id="${escapeAttribute(`menu-${id}`)}" popover aria-label="${escapeAttribute(label)}"><p class="menu-head">${escapeHtml(label)}</p>${items.join("")}</div>`;

/** `aria-label` naming whose item this is, "Settings, Kudos", keeping the visible label first. */
const itemName = (label: string, target?: string) =>
  target === undefined ? "" : ` aria-label="${escapeAttribute(`${label}, ${target}`)}"`;

/** A menu item that navigates; `target` names whose it is for screen readers and agents. */
export const menuLink = (path: string, label: string, danger = false, target?: string) =>
  `<a class="menu-item${danger ? " menu-item-danger" : ""}" href="${escapeAttribute(path)}"${itemName(label, target)}>${escapeHtml(label)}</a>`;

/** A menu item that posts its own form; `fields` is trusted HTML, usually hidden inputs. */
export const menuPost = (
  path: string,
  label: string,
  fields = "",
  danger = false,
  target?: string
) =>
  `<form method="post" action="${escapeAttribute(path)}">${fields}<button class="menu-item${danger ? " menu-item-danger" : ""}" type="submit"${itemName(label, target)}>${escapeHtml(label)}</button></form>`;

/** A menu item that copies `text`, hidden until the page's copy script reveals it. */
export const menuCopy = (text: string, label: string, target?: string) =>
  `<button class="menu-item" type="button" data-copy="${escapeAttribute(text)}"${itemName(label, target)} aria-live="polite" hidden>${escapeHtml(label)}</button>`;

/**
 * A GET search form over `q`. `keep` holds other query parameters to carry; `className` is the
 * page's layout hook for the form.
 */
export const searchField = (input: {
  readonly action: string;
  readonly id: string;
  readonly query: string;
  readonly placeholder: string;
  readonly label: string;
  readonly keep?: Readonly<Record<string, string>>;
  readonly className?: string;
}) =>
  `<form${input.className === undefined ? "" : ` class="${escapeAttribute(input.className)}"`} method="get" action="${escapeAttribute(input.action)}" role="search">${Object.entries(
    input.keep ?? {}
  )
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`
    )
    .join(
      ""
    )}<div class="field field-group field-search"><label class="field-prefix" for="${escapeAttribute(input.id)}">${searchIcon}</label><input id="${escapeAttribute(input.id)}" type="search" name="q" value="${escapeAttribute(input.query)}" maxlength="200" placeholder="${escapeAttribute(input.placeholder)}" aria-label="${escapeAttribute(input.label)}"></div></form>`;

const dataAttributes = (data: Readonly<Record<string, string>> | undefined) =>
  Object.entries(data ?? {})
    .map(([key, value]) => ` data-${escapeAttribute(key)}="${escapeAttribute(value)}"`)
    .join("");

/** One choice of `tileOptions`. */
export interface TileOption {
  readonly value: string;
  /** The row's name, which is the choice's accessible name. */
  readonly name: string;
  /** A line about it, read as the choice's description. */
  readonly text: string;
  /** Trusted markup for the row's mark, such as `patchMark`'s or a `mono-placeholder`. */
  readonly mark: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Dashes the row, as one standing in for something to make. */
  readonly placeholder?: boolean;
  /** `data-*` attributes on the radio, for a page's script. */
  readonly data?: Readonly<Record<string, string>>;
}

/**
 * A radio group drawn as tile rows. Put it in a fieldset whose legend names the group; `name` is
 * the form field and seeds each option's id, so it must be unique on the page.
 */
export const tileOptions = (name: string, options: readonly TileOption[]) =>
  `<div class="tile-options">${options
    .map((option, index) => {
      const id = `${name}-option-${index}`;
      return `<label class="tile-row tile-option${option.placeholder === true ? " tile-row-placeholder" : ""}"><input type="radio" name="${escapeAttribute(name)}" value="${escapeAttribute(option.value)}" aria-labelledby="${escapeAttribute(`${id}-name`)}" aria-describedby="${escapeAttribute(`${id}-text`)}"${option.checked === true ? " checked" : ""}${option.disabled === true ? " disabled" : ""}${dataAttributes(option.data)}>${option.mark}<span class="tile-body"><span class="tile-name" id="${escapeAttribute(`${id}-name`)}">${escapeHtml(option.name)}</span><span class="tile-text" id="${escapeAttribute(`${id}-text`)}">${escapeHtml(option.text)}</span></span></label>`;
    })
    .join("")}</div>`;

/** One choice of `choiceCards`. */
export interface ChoiceCard {
  readonly value: string;
  readonly title: string;
  /** What choosing it means, a line each, read as the choice's description. */
  readonly points: readonly string[];
  readonly checked?: boolean;
  readonly disabled?: boolean;
}

/**
 * A radio group drawn as cards side by side. Put it in a fieldset whose legend names the group;
 * `name` is the form field and seeds each card's id, so it must be unique on the page.
 */
export const choiceCards = (name: string, cards: readonly ChoiceCard[]) =>
  `<div class="choice-cards">${cards
    .map((card, index) => {
      const id = `${name}-card-${index}`;
      return `<label class="choice-card"><input type="radio" name="${escapeAttribute(name)}" value="${escapeAttribute(card.value)}" aria-labelledby="${escapeAttribute(`${id}-title`)}" aria-describedby="${escapeAttribute(`${id}-points`)}"${card.checked === true ? " checked" : ""}${card.disabled === true ? " disabled" : ""}><span class="choice-card-title" id="${escapeAttribute(`${id}-title`)}">${escapeHtml(card.title)}</span><span id="${escapeAttribute(`${id}-points`)}">${card.points.map((point) => `<span class="choice-card-point">${escapeHtml(point)}</span>`).join("")}</span></label>`;
    })
    .join("")}</div>`;
