/**
 * Addresses into What's new. Each month that has a release has its own page, `/whats-new/2026-11`,
 * and `/whats-new` shows the newest of them. A change's permalink is its month's page opened at
 * it, `#change-<release>-<n>`: release ids are never reused and a release's changes keep their
 * order once deployed, so the address never moves.
 *
 * Opening What's new's panel or the newest month raises the person's seen marker, so a link out of
 * a panel or page drawn before that carries the marker it was drawn with as `?since=`, and the
 * month it opens still marks what is new to them.
 */
import { whatsNewPath } from "./places.js";
import { type Change, type Release, releases } from "./whatsNew.js";

/** A release's month, `YYYY-MM`, which names its page. */
export const monthOf = (release: Pick<Release, "date">) => release.date.slice(0, 7);

/** The `n`th change of a release, as its month's page names it. */
export const changeId = (release: Pick<Release, "id">, n: number) => `change-${release.id}-${n}`;

/** A month's page, or the newest month's at `/whats-new`, marking what is new since `since` when it is given. */
export const monthHref = (month?: string, since?: number) =>
  `${whatsNewPath}${month === undefined ? "" : `/${month}`}${since === undefined ? "" : `?since=${since}`}`;

/** The `n`th change of a release, on its month's page, which opens it. */
export const permalink = (release: Pick<Release, "id" | "date">, n: number, since?: number) =>
  `${monthHref(monthOf(release), since)}#${changeId(release, n)}`;

/** A change with the release it shipped in and its place there, newest first. */
export interface Entry {
  readonly release: Release;
  readonly n: number;
  readonly change: Change;
}

/** Every change released after `seen`, newest first, with what its permalink needs. */
export const entriesSince = (seen: number): ReadonlyArray<Entry> =>
  releases
    .filter((release) => release.id > seen)
    .flatMap((release) => release.changes.map((change, n) => ({ release, n, change })));
