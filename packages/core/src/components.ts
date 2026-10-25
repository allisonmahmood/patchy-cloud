import { escapeAttribute, escapeHtml } from "./html.js";

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

/**
 * A patch's mark: two letters from its name on a tint picked from it, or a ruled sheet for a
 * tier 0 page. `large` is the size beside a page heading.
 */
export const patchMark = (name: string, tier: number, large = false) => {
  if (tier === 0)
    return `<span class="page-mark${large ? " page-mark-lg" : ""}" aria-hidden="true"></span>`;
  const words = name.split("-").filter((word) => word !== "");
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2);
  const tint = pick(name, ["", " mono-blue", " mono-green", " mono-amber", " mono-pink"]);
  return `<span class="mono${tint}${large ? " mono-lg" : ""}" aria-hidden="true">${escapeHtml(letters.toUpperCase())}</span>`;
};

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
