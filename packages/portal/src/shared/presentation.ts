// How more than one portal surface presents a patch: its paths, menus and search, its failures
// cell and the hidden fields its forms carry. Surfaces share only through `shared/`.
import type { RequireSession } from "@patchy/auth";
import {
  badge,
  type Column,
  escapeAttribute,
  menuCopy,
  menuLink,
  menuNewTab,
  patchTitle
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import type { InvocationLog } from "@patchy/runtime";

// The index line: text up to the first sentence-ending period or ellipsis, semicolon or spaced
// en dash, bounded to 80 code points. A period inside a token (".NET", "1.2") is not a boundary.
export const firstClause = (description: string): string => {
  const text = description.trim();
  const boundary = text.search(/\.+(?=\s|$)|;| – /u);
  const clause = boundary === -1 ? text : text.slice(0, boundary).trimEnd();
  const points = Array.from(clause);
  return points.length > 80 ? `${points.slice(0, 79).join("").trimEnd()}…` : clause;
};

export const hidden = (name: string, value: string | number | null) =>
  `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value ?? "")}">`;

/** What the card and Needs attention call a patch its guests can't open. */
export const turnedAwayTitle = "Guests can't open this";

const DAY = 86_400_000;
/** How long a patch counts as new to someone who hasn't opened it. */
const RECENT = 7 * DAY;

type Viewer = RequireSession.Viewer["Service"];
const epoch = (iso: string) => Date.parse(iso);

/** A `?q=` as searched: trimmed and cut to 200 code points, never mid-character. */
export const searchQuery = (raw: string | null) =>
  Array.from((raw ?? "").trim())
    .slice(0, 200)
    .join("");

/** A search over live or off patches: case-insensitive, across name, title, description and owner name. */
export const matches = (row: Patches.ReadPatch, query: string): boolean => {
  const needle = query.toLowerCase();
  return [row.patch.name, row.patch.title, row.patch.description, row.owner.name].some((field) =>
    field.toLowerCase().includes(needle)
  );
};

/** Patches A–Z by what people see them called at `company`, then by name, which no two share. */
export const byTitle = (company: string) => (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
  patchTitle(a.patch, company).localeCompare(patchTitle(b.patch, company)) ||
  a.patch.name.localeCompare(b.patch.name);

/** Whether the viewer may manage this patch: its owner, or any admin. */
export const manages = (row: Patches.ReadPatch, viewer: Viewer) =>
  viewer.role === "admin" || row.owner.id === viewer.user.id;

/** Created in the last week by someone else, and not yet opened by the viewer. */
export const isNew = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  opens: ReadonlyMap<string, Patches.Open>,
  now: number
) =>
  row.owner.id !== viewer.user.id &&
  now - epoch(row.patch.createdAt) < RECENT &&
  !opens.has(row.patch.id);

/** A patch's card at `/patches/<name>`, or one of its pages under it. */
export const cardPath = (patch: Patches.Patch, action = "") =>
  `/patches/${encodeURIComponent(patch.name)}${action ? `/${action}` : ""}`;

/** The log filtered to its failed entries. */
export const failedLog = (patch: Patches.Patch) =>
  `/patches/${encodeURIComponent(patch.name)}/log?outcome=failed`;

/**
 * The column of a tool's calls in the last 24 hours, which its header says, on Home's Yours and
 * All patches alike: `failuresCell` fills it, and on a phone, where it is gone, `failedBadge`
 * says the same under the patch's name.
 */
export const failuresColumn: Column = { label: "Failures (24 h)", hideOnPhone: true, nowrap: true };

/** How many calls failed, linked to the log filtered to them; nothing when none did. */
export const failedBadge = (
  patch: Patches.Patch,
  summary: InvocationLog.CallSummary | undefined
) =>
  summary === undefined || summary.failures === 0
    ? ""
    : `<a href="${escapeAttribute(failedLog(patch))}">${badge(`${summary.failures} failed`, "danger")}</a>`;

/**
 * A `failuresColumn` cell: None, No calls yet, or how many failed, never that a tool is healthy;
 * a dash for a patch without a summary, such as a page.
 */
export const failuresCell = (
  patch: Patches.Patch,
  summary: InvocationLog.CallSummary | undefined
) =>
  summary === undefined
    ? '<span class="muted">—</span>'
    : summary.failures > 0
      ? failedBadge(patch, summary)
      : `<span class="muted">${summary.calls === 0 ? "No calls yet" : "None"}</span>`;

/** A live patch's address, relative to the instance. */
export const patchAddress = (patch: Patches.Patch) =>
  `/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;

/** `here`, the page a menu is on, with the Share dialog for patch `name` open over it. */
export const shareHref = (here: string, name: string) => {
  const url = new URL(here, "http://patchy.invalid");
  url.searchParams.set("share", name);
  return `${url.pathname}${url.search}`;
};

/**
 * The ways to open a patch, Share… for one the viewer manages, then its card, as a row's menu
 * starts on Home and All patches. Its name already opens a live patch, so the menu offers a new
 * tab, the link and About this patch; the card's own menu is these without About. `here` is the
 * page the menu is on, which the Share dialog opens over.
 */
export const openItems = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  publicBaseUrl: string,
  here: string,
  about = true
) => {
  const { patch } = row;
  const title = patchTitle(patch, viewer.company.name);
  const live = patch.state === "live";
  return [
    ...(live
      ? [
          menuNewTab(patchAddress(patch), title),
          menuCopy(
            `${publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`,
            "Copy link",
            title
          )
        ]
      : []),
    ...(live && manages(row, viewer)
      ? [menuLink(shareHref(here, patch.name), "Share…", false, title)]
      : []),
    ...(about ? [menuLink(cardPath(patch), "About this patch", false, title)] : [])
  ];
};
