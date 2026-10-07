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
    id: 6,
    date: "2026-10-07",
    through: "b765183b91b6335fffec5b70b33ad1f2b8b235f4",
    changes: [
      {
        kind: "New",
        title: "A guide to your first patch",
        detail:
          "Until you have a patch of your own, Patches opens on a short guide: what Patchy is, the line to give your AI agent, and what to ask it for, each with a Copy button. It moves on as you go and steps aside once your first patch is live.",
        prs: [571]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 5,
    date: "2026-10-06",
    through: "5b1a62de21d43e3a06cde0571bb601ee4260f422",
    changes: [
      {
        kind: "Fixed",
        title: "The bell and text buttons no longer leave a stray shadow",
        detail:
          "Pointing at or tapping the bell, Sign out, Cancel, or Hide and Not now on a patch’s notices used to draw a black shadow with no box around it. They now turn light blue instead, and the bell turns yellow while its panel is open.",
        prs: [559]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 4,
    date: "2026-10-06",
    through: "86974632738a3fcc19935ee4b28e7b87fc494a9a",
    changes: [
      {
        kind: "New",
        title: "See what’s new in Patchy",
        detail:
          "A bell beside your name shows a dot when something has shipped since you last looked. Open it for the latest changes, or choose See all changes for the full history.",
        prs: [555]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 3,
    date: "2026-10-06",
    through: "4a928f7b3c821b4d6941c4ea9968d43773897526",
    changes: [
      {
        kind: "Fixed",
        title: "Creating a company explains a handle it can’t use",
        detail:
          "If Patchy can’t use the company handle you typed, it now says why beside the field and suggests one that works when it can. Before, some mistakes, like a capital letter, stopped the form without saying why.",
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
      "We now record key moments, like creating a company, inviting a colleague or retiring a patch, so we can see where people get stuck. They identify people by id, never by name or email address.",
      "The patchy command now tells us its version, which command ran and which coding agent ran it, so we can fix problems faster."
    ]
  },
  {
    id: 1,
    date: "2026-10-05",
    through: "48153dc8ba948d6903f735be1f5598b6386e6e60",
    changes: [],
    behindTheScenes: ["Patchy Cloud’s first release went live on its own production servers."]
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
