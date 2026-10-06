/**
 * What's new: the changelog behind the app shell's bell and `/whats-new`. It ships with the
 * server, so production shows the releases its own commit carries, and a rollback shows the
 * older list.
 *
 * The agent that deploys writes the next release, following AGENTS.md › Deploying. Put it
 * first: `id` one above the newest, `date` today, `through` the full sha of `origin/main`
 * that it was written from. It covers what merged after the previous release's `through`.
 * Never reuse or renumber an id: each person's seen marker compares against it.
 *
 * Write for a colleague who has never read the code.
 * - One change per thing a person would notice. Combine PRs that make one change, and split
 *   a PR that makes two. Lead with what they can do now or what stopped going wrong, in
 *   everyday words and short sentences.
 * - New: something they could not do before. Improved: something that works better. Fixed:
 *   something that was broken.
 * - Work nobody would notice goes in `behindTheScenes`, a plain sentence per kind of work;
 *   test and tooling churn needs no line at all.
 * - No PR numbers, file paths, jargon, hype, or "bug fixes and improvements". Announce only
 *   what this deploy makes available: nothing behind a flag or waiting on infrastructure.
 */

/** New: they could not do it before. Improved: it works better. Fixed: it was broken. */
export type ChangeKind = "New" | "Improved" | "Fixed";

export interface Change {
  readonly kind: ChangeKind;
  /** A short headline in the reader's words. */
  readonly title: string;
  /** A sentence or two: what it means for them, and where to find it if that helps. */
  readonly detail: string;
  /** The merged PRs it describes, for review; readers never see them. */
  readonly prs: ReadonlyArray<number>;
}

export interface Release {
  /** One above the previous release. A person has seen everything up to their marker's id. */
  readonly id: number;
  /** The day it was written, just before its deploy: `YYYY-MM-DD`. */
  readonly date: string;
  /** The full sha of main it was written from; the next release starts after it. */
  readonly through: string;
  readonly changes: ReadonlyArray<Change>;
  readonly behindTheScenes: ReadonlyArray<string>;
}

/** Newest first. */
export const releases: ReadonlyArray<Release> = [
  {
    id: 3,
    date: "2026-10-06",
    through: "4a928f7b3c821b4d6941c4ea9968d43773897526",
    changes: [
      {
        kind: "Fixed",
        title: "Clearer company handle errors",
        detail:
          "When you create a company, Patchy explains a handle it can’t use right beside the field, with a fix to try when there is one. Before, some mistakes stopped the form without saying why.",
        prs: [553]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 2,
    date: "2026-10-05",
    through: "aed1454ba2b67a0df52f2017ff7ea7350af6d3ba",
    changes: [],
    behindTheScenes: [
      "We can see where people get stuck while setting up, so we can smooth it out.",
      "Changes to patches are recorded the same way whether they come from the portal or an agent.",
      "The patchy command tells us its version and which coding agent runs it, so we can fix problems faster."
    ]
  },
  {
    id: 1,
    date: "2026-10-05",
    through: "48153dc8ba948d6903f735be1f5598b6386e6e60",
    changes: [],
    behindTheScenes: ["Patchy Cloud’s first release on its production servers."]
  }
];

/** The newest release's id: a new member starts here, caught up. */
export const latestRelease = releases[0]?.id ?? 0;

/** Every change released after `seen`, newest first. */
export const changesSince = (seen: number): ReadonlyArray<Change> =>
  releases.filter((release) => release.id > seen).flatMap((release) => release.changes);

/** "1 new · 2 improved · 7 fixed", leaving out kinds with none. */
export const tally = (changes: ReadonlyArray<Change>): string =>
  (["New", "Improved", "Fixed"] as const)
    .map((kind) => [kind, changes.filter((change) => change.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind.toLowerCase()}`)
    .join(" · ");
