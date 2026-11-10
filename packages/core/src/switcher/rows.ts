// @effect-diagnostics globalDate:off
// The menu runs in the browser without Effect; "Yesterday" and "Mon" are the viewer's local days.
/**
 * What the switcher lists, as data the menu draws.
 *
 * Nothing typed: the patch to flip back to, selected, then the next five the viewer opened last;
 * slots they haven't filled go to patches the viewer has never opened, the company's before those
 * shared with them, each by title, six patches in all. Without a patch to flip back to, none of
 * them is lit. Then "This patch", the card pages of the patch on screen (Log and Settings for its owner and
 * admins), shown once the list confirms the viewer is a member of its company, so never to a
 * guest, then "Patchy", Patchy's own places. Typed: everything filters into one ranked list
 * (`rank.ts`). The patch on screen is never a row, nor the place the page is.
 *
 * Every address comes from the current list, never from storage, so a flip from a historical
 * version lands on the patch's current one, and a renamed patch goes by its new name.
 */
import { patchTitle } from "../patch-marks.js";
import { pagePlaces, type Place, places, whatsNewPath } from "../places.js";
import type { Kept } from "./cache.js";
import { byTitle, rank } from "./rank.js";

/** An icon a row may wear instead of a patch's mark. */
export type Icon =
  | "home"
  | "patches"
  | "agents"
  | "people"
  | "integrations"
  | "agent-access"
  | "whats-new"
  | "overview"
  | "versions"
  | "log"
  | "settings";

export interface Row {
  /** Stable across refreshes: `patch:<id>`, `card:<tab>` or `place:<section>`. */
  readonly key: string;
  readonly href: string;
  readonly title: string;
  readonly mark:
    { readonly patch: { readonly name: string; readonly tier: number } } | { readonly icon: Icon };
  /** When the viewer last opened it, or whose a shared patch is. */
  readonly detail?: string | undefined;
  /** What's new has changes the viewer hasn't seen. */
  readonly dot?: boolean;
  /** For ranking: a second name it answers to, and how much the viewer uses it (places: -1). */
  readonly name?: string | undefined;
  readonly score?: number | undefined;
  /** When the viewer last opened it, in epoch milliseconds. */
  readonly openedAt?: number | undefined;
}

export interface Section {
  readonly label?: "This patch" | "Patchy";
  readonly rows: ReadonlyArray<Row>;
  /** None of these rows is lit when the menu opens: patches with no flip to lead them. */
  readonly quiet?: boolean;
}

/** The row the menu lights when it opens on `sections`: the first one not in a quiet section. */
export const litAtOpen = (sections: ReadonlyArray<Section>): number => {
  let index = 0;
  for (const section of sections) {
    if (section.quiet !== true) return index;
    index += section.rows.length;
  }
  return 0;
};

/** Where the menu opened. */
export interface Here {
  /** The patch a shell shows. */
  readonly patch?: string | undefined;
  /** The page's path, which leaves its own place out. */
  readonly path: string;
}

/** The icon each of the sidebar's places wears in the menu. */
const placeIcons: Readonly<Record<Place["section"], Icon>> = {
  home: "home",
  patches: "patches",
  agents: "agents",
  people: "people",
  integrations: "integrations",
  "agent-access": "agent-access"
};

/** The sidebar place that opens on `place` without being a page, as Settings opens People. */
const opener = (place: Place) =>
  places.find((parent) => "children" in parent && parent.href === place.href)?.label;

/**
 * Patchy's places, the page's own left out: every sidebar place with a page, each also found by
 * the name of a place that opens on it ("settings" finds People), then What's new. A place ranks
 * below a patch or one of its pages that matches as well, so "set" on a patch finds its Settings
 * first.
 */
const placeRows = (here: Here, unseen: number): Row[] =>
  [
    ...pagePlaces.map((place): Row => ({
      key: `place:${place.section}`,
      href: place.href,
      title: place.label,
      mark: { icon: placeIcons[place.section] },
      name: opener(place),
      score: -1
    })),
    {
      key: "place:whats-new",
      href: whatsNewPath,
      title: "What’s new",
      mark: { icon: "whats-new" },
      dot: unseen > 0,
      score: -1
    } satisfies Row
  ].filter((row) => row.href !== here.path);

const minute = 60_000;
const hour = 60 * minute;
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "4 min", "1 h", "Yesterday", "Mon", "3 wk", "Oct 2": how long since `at`, in local time. */
export const sinceLabel = (at: number, now: number): string => {
  const since = Math.max(0, now - at);
  if (since < minute) return "now";
  if (since < hour) return `${Math.floor(since / minute)} min`;
  const then = new Date(at);
  const today = new Date(now);
  const midnight = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(then)) / (24 * hour));
  if (days <= 0) return `${Math.floor(since / hour)} h`;
  if (days === 1) return "Yesterday";
  if (days < 7) return weekdays[then.getDay()]!;
  if (days < 30) return `${Math.floor(days / 7)} wk`;
  const year = then.getFullYear() === today.getFullYear() ? "" : `, ${then.getFullYear()}`;
  return `${months[then.getMonth()]} ${then.getDate()}${year}`;
};

const path = (handle: string, name: string) =>
  `/${encodeURIComponent(handle)}/${encodeURIComponent(name)}`;

/**
 * The menu's sections for `query`, from what the tab keeps, as at `now`. On a refresh of an open
 * menu, `shown` is the rows it shows: those still listed keep their slots ahead of newcomers, so
 * the six-patch cap never pushes out a row the person may have lit.
 */
export const sections = (
  kept: Kept,
  here: Here,
  query: string,
  now: number,
  shown: ReadonlyArray<string> = []
): Section[] => {
  const { list } = kept;
  const notHere = (row: Row) => row.key !== `patch:${here.patch}`;
  const companyRows: Row[] = list
    ? list.patches
        .map((patch) => {
          const openedAt = patch.openedAt === undefined ? undefined : Date.parse(patch.openedAt);
          return {
            key: `patch:${patch.id}`,
            href: path(list.company.handle, patch.name),
            title: patchTitle(patch, list.company.name),
            mark: { patch: { name: patch.name, tier: patch.tier } },
            detail: openedAt === undefined ? undefined : sinceLabel(openedAt, now),
            name: patch.name,
            score: patch.score,
            openedAt
          };
        })
        .filter(notHere)
    : [];
  const sharedRows: Row[] = list
    ? list.shared
        .map((patch) => ({
          key: `patch:${patch.id}`,
          href: path(patch.company.handle, patch.name),
          title: patchTitle(patch, patch.company.name),
          mark: { patch: { name: patch.name, tier: patch.tier } },
          detail: patch.company.name,
          name: patch.name
        }))
        .filter(notHere)
    : [];
  const patchRows = [...companyRows, ...sharedRows];
  const mine = list?.patches.find((patch) => patch.id === here.patch);
  const manages = mine !== undefined && (mine.mine || list?.viewer.role === "admin");
  const cardRows: Row[] =
    mine === undefined
      ? []
      : (
          [
            ["overview", "Overview", ""],
            ["versions", "Versions", "/versions"],
            ["log", "Log", "/log"],
            ["settings", "Settings", "/settings"]
          ] as const
        )
          .filter(([tab]) => manages || tab === "overview" || tab === "versions")
          .map(([tab, title, suffix]) => ({
            key: `card:${tab}`,
            href: `/patches/${encodeURIComponent(mine.name)}${suffix}`,
            title,
            mark: { icon: tab }
          }));
  const placesRows = placeRows(here, list?.whatsNewUnseen ?? 0);

  if (query.trim() !== "") {
    const found = rank(query, [...patchRows, ...cardRows, ...placesRows].map(ranked));
    return found.length === 0 ? [] : [{ rows: found.map(({ row }) => row) }];
  }

  const byKey = new Map(patchRows.map((row) => [row.key, row]));
  // The flip: the tab's last patch other than this one, else the one opened most recently.
  const recent = patchRows
    .filter((row) => row.openedAt !== undefined)
    .sort((a, b) => b.openedAt! - a.openedAt! || (a.key < b.key ? -1 : 1));
  const pointed = [kept.current, kept.previous]
    .map((id) => (id === undefined || id === here.patch ? undefined : byKey.get(`patch:${id}`)))
    .find((row) => row !== undefined);
  const flip = pointed ?? recent[0];
  // Patches never opened fill what opens leave, so a new member or a guest has some at once.
  // Guests record no opens, so every shared patch counts as never opened.
  const titled = (rows: ReadonlyArray<Row>) =>
    rows
      .map((row) => ({ id: row.key, title: row.title, row }))
      .sort(byTitle)
      .map(({ row }) => row);
  const unopened = [
    ...titled(companyRows.filter((row) => row.openedAt === undefined)),
    ...titled(sharedRows)
  ];
  const lead = [
    ...(flip === undefined ? [] : [flip]),
    ...[...recent, ...unopened].filter((row) => row !== flip)
  ];
  const onScreen = new Set(shown);
  const first = [
    ...lead.filter((row) => onScreen.has(row.key)),
    ...lead.filter((row) => !onScreen.has(row.key))
  ].slice(0, 6);
  return [
    ...(first.length === 0
      ? []
      : [{ rows: first, ...(flip === undefined ? { quiet: true } : {}) }]),
    ...(cardRows.length === 0 ? [] : [{ label: "This patch" as const, rows: cardRows }]),
    { label: "Patchy" as const, rows: placesRows }
  ];
};

/** A row as `rank` reads it, carrying the row. */
const ranked = (row: Row) => ({
  id: row.key,
  title: row.title,
  name: row.name,
  score: row.score,
  row
});

/** The row a search that matched nothing offers: All patches. */
export const allPatchesRow = (): Row =>
  placeRows({ path: "" }, 0).find((row) => row.key === "place:patches")!;

/**
 * `next` as the open menu shows it after a refresh: rows it already showed keep their order, and
 * new rows go at the end of their section.
 */
export const hold = (next: ReadonlyArray<Section>, shown: ReadonlyArray<string>): Section[] => {
  const at = new Map(shown.map((key, index) => [key, index]));
  return next.map((section) => ({
    ...section,
    rows: section.rows
      .map((row, index) => ({ row, index, was: at.get(row.key) }))
      .sort((a, b) =>
        a.was === undefined
          ? b.was === undefined
            ? a.index - b.index
            : 1
          : b.was === undefined
            ? -1
            : a.was - b.was
      )
      .map(({ row }) => row)
  }));
};
