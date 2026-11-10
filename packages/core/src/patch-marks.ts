import { escapeHtml } from "./escape.js";

/**
 * What a patch is called and the mark it wears, wherever Patchy draws it: server pages and the
 * switcher in the browser. It depends only on escaping, so a browser script can carry it.
 */

/**
 * What people see a patch called, everywhere Patchy lists or heads it: its title, less the
 * " · Brightline Studio" its own HTML often ends with, since Patchy already says whose it is; else
 * its name. `company` is the name of the company the patch belongs to, which for a patch shared
 * with a guest is the one that shared it. Addresses, and anything typed to confirm, use the name.
 */
export const patchTitle = (
  patch: { readonly name: string; readonly title: string },
  company: string
): string => {
  const title = patch.title.trim() || patch.name;
  // The whole company name first, so one with a separator of its own, "Harbor - Pine", still
  // matches; then the spaced separator before it.
  const suffix = company.trim();
  const end = title.slice(title.length - suffix.length);
  if (suffix === "" || end.toLowerCase() !== suffix.toLowerCase()) return title;
  return (
    title.slice(0, title.length - suffix.length).match(/^(.*\S)\s+[·•|–—-]\s+$/u)?.[1] ?? title
  );
};

/**
 * A page runs only in the viewer's browser: a tier 1 patch. A tool is tier 2, with code on the
 * server. Shelves and marks tell them apart.
 */
export const isPage = (patch: { readonly tier: number }): boolean => patch.tier === 1;

/** Picks one of `choices` from a key, so the same person or patch always gets the same one. */
export const pick = <T>(key: string, choices: readonly [T, ...T[]]): T =>
  choices[Array.from(key).reduce((sum, char) => sum + char.charCodeAt(0), 0) % choices.length]!;

/**
 * The tint class a patch's monogram wears, picked from its name; `""` is the plain one. Anything
 * that draws a patch's mark in the browser uses this, so it matches the pages Patchy renders.
 */
export const monogramTint = (name: string) =>
  pick(name, ["", "mono-blue", "mono-green", "mono-amber", "mono-pink"] as const);

/** Two letters from `name` on a tint picked from it. `large` is the size beside a page heading. */
export const monogram = (name: string, large = false) => {
  const words = name.split("-").filter((word) => word !== "");
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2);
  const tint = monogramTint(name);
  return `<span class="mono${tint === "" ? "" : ` ${tint}`}${large ? " mono-lg" : ""}" aria-hidden="true">${escapeHtml(letters.toUpperCase())}</span>`;
};

/** A patch's mark: a ruled sheet for a page, else its monogram. */
export const patchMark = (name: string, tier: number, large = false) =>
  isPage({ tier })
    ? `<span class="page-mark${large ? " page-mark-lg" : ""}" aria-hidden="true"></span>`
    : monogram(name, large);
