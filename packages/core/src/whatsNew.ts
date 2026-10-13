/**
 * What's new: the changelog behind the app shell's bell and `/whats-new`. It ships with the
 * server, so production shows the releases its own commit carries, and a rollback shows the
 * older list.
 *
 * The agent that deploys writes the next release, following AGENTS.md › Deploying. Put it
 * first: `id` one above the newest, `date` today, `through` the full sha of `origin/main`
 * that it was written from. It covers what merged after the previous release's `through`.
 * Never reuse or renumber an id: each person's seen marker compares against it. Set the
 * `patchy` version in `packages/patchy/package.json` and `CURRENT_RELEASE` in
 * `packages/api/src/schemas.ts` to `0.<id>.0`, so CLIs and patch repos installed before this
 * deploy are told to upgrade.
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
    id: 11,
    date: "2026-10-13",
    through: "a253cb2df4da03fbbac3f4dad9ec376a95115aad",
    changes: [
      {
        kind: "New",
        title: "Tools can show your PostHog data",
        detail:
          "An admin can now connect your company's PostHog project on the Connections page. Your AI agent can then build dashboards and tools that read its events and numbers. They only read: nothing a tool does changes your PostHog data. While your agent builds, it works from the real data, so what you try is what your team will see.",
        prs: [662, 664]
      },
      {
        kind: "Improved",
        title: "The Connections page stays clear with one connection or thirty",
        detail:
          "Each of your company's data connections is now one row in a table that shows what it reaches, whether it's working and which tools use it. New ones start from Connect a source, and each connection's own page keeps its actions together. If you need a source Patchy doesn't connect yet, the page tells you how to ask.",
        prs: [657]
      },
      {
        kind: "Improved",
        title: "Find anyone on the Company page",
        detail:
          "The Company page is now one table of people and invites, with a search box and tabs for admins, invites and deactivated people. Invites that need you, because the email didn't go out or the invite expired, come first with a Resend button beside them. Each row keeps its actions in one menu.",
        prs: [661]
      },
      {
        kind: "New",
        title: "Invite many people at once",
        detail:
          "Paste up to 50 email addresses into the invite box, separated by commas or new lines, and each person gets their own invitation. If any address is wrong, nothing is sent and your list stays in the box so you can fix it.",
        prs: [661]
      },
      {
        kind: "Fixed",
        title: "Browser tabs show Patchy's icon and your tool's name",
        detail:
          "Patchy's pages and your tools now show Patchy's icon in the browser tab instead of a blank square. A tool's tab shows the title its page gives it rather than its web address. Existing tools pick up their title the next time they are published.",
        prs: [660]
      }
    ],
    behindTheScenes: [
      "Each version of Patchy now skips kinds of connection it doesn't know, so going back to an earlier version stays safe."
    ]
  },
  {
    id: 10,
    date: "2026-10-13",
    through: "64458b2207890bb9d5674ebde038a65c86ea7652",
    changes: [
      {
        kind: "Fixed",
        title: "New pages and tools no longer get lost in a temporary folder",
        detail:
          "Your AI agent now keeps the pages and tools it makes in a Patchy folder in your home folder, unless you choose another, and tells you where they are. Before, they could land in a temporary folder, which made a page hard to update later and could lose the only copy of a tool. Setting up Patchy again on another computer now updates your welcome page instead of making a second one.",
        prs: [658]
      },
      {
        kind: "Fixed",
        title: "Your agent hears when its copy of Patchy is out of date",
        detail:
          "Each Patchy update now has its own version number. When your AI agent publishes a page, starts a new tool or publishes the company look with an older copy of the patchy command, it is told to update first, and the update brings its newest instructions too. An older copy used to carry on without ever finding out.",
        prs: [649, 654]
      },
      {
        kind: "Improved",
        title: "See a sample tool in your look before you approve it",
        detail:
          "When your agent captures your company's look, it now also builds a small sample tool in it, with your logo, a filter, a table and buttons, and shows it beside the sample page. You see how your tools will really look before you agree, and the agent fills any gaps the sample finds in the look's brief.",
        prs: [656]
      },
      {
        kind: "Improved",
        title: "Publishing the company look says who it's for",
        detail:
          "When an admin's agent publishes the company look, it now says the look is for everyone at the company and that colleagues' agents use it for new pages and tools with nothing to set up. It no longer offers to keep a copy of the look's files, since Patchy already holds them.",
        prs: [655]
      }
    ],
    behindTheScenes: [
      "Connections to your company's data now record what kind of service each one reaches."
    ]
  },
  {
    id: 9,
    date: "2026-10-10",
    through: "7164ab47d3965e2ca432f0e9660fcfcd40e9ef45",
    changes: [
      {
        kind: "Fixed",
        title: "Trying a patch on your computer no longer shows a false error",
        detail:
          "When your AI agent deletes or replaces a patch's server code while the patch runs on your computer, Patchy now picks up the change. It used to print an error saying it could not watch the server files.",
        prs: [613]
      }
    ],
    behindTheScenes: [
      "The machines that run your tools' server code keep up their routine upkeep when the database is slow to answer, instead of stopping early and trying again later."
    ]
  },
  {
    id: 8,
    date: "2026-10-07",
    through: "f11604cde938a7115b16ff385b93f2f73fffd55c",
    changes: [
      {
        kind: "New",
        title: "Your tools can look like your company",
        detail:
          "An admin's agent can now publish a company look: your colours, type, spacing and a short brief on how your brand reads. Every new patch starts in it, so the first page your agent builds already looks like you, and your agent sees the brief before it styles anything. Patchy never enforces it: a Halloween page or a page for a client can look however you ask. Admins can publish a new revision or go back to an earlier one, and anyone can ask their agent what the company look is.",
        prs: [577, 579]
      },
      {
        kind: "New",
        title: "Preview a look before you publish it",
        detail:
          "Your agent can render any candidate look on a fixed sample page, headings, buttons, a table, a form, badges and colour swatches, and show it beside the current look, so you judge a picture rather than a stylesheet. The same checks that publishing runs are listed with the preview, so problems get fixed before anything changes for your colleagues.",
        prs: [578]
      },
      {
        kind: "New",
        title: "Setting up Patchy sets up your look",
        detail:
          "When you create a company, your agent guesses your website from your email address and asks whether your tools should look like it. If you say yes, it captures the look, shows you the sample page, and publishes it, so your welcome page and every tool after it start in your company's look. People who join later are told their tools will use it, with nothing to set up.",
        prs: [598]
      },
      {
        kind: "Improved",
        title: "Patches hear when the look changes",
        detail:
          "When an admin publishes or restores a look, each patch picks it up the next time its agent starts or refreshes it, and says what changed and who changed it. Publishing a patch that is behind warns you and ships the look it was built with, so nothing goes live in a look nobody has checked.",
        prs: [581]
      },
      {
        kind: "Improved",
        title: "Static pages can use embedded fonts",
        detail:
          "A static page can now carry its own font inside the page, so a company look's typeface shows on every tier. Fonts fetched from other sites stay blocked.",
        prs: [576]
      }
    ],
    behindTheScenes: [
      "Your agent no longer keeps a personal style file on your computer; the company look replaces it."
    ]
  },
  {
    id: 7,
    date: "2026-10-07",
    through: "48704b0e786e380cff38819aab1b422bd3c1219a",
    changes: [
      {
        kind: "Fixed",
        title: "A patch that fails to set up says why",
        detail:
          "When your AI agent starts or refreshes a patch and its packages fail to install, the patchy command now gives the reason, like a download that wasn’t found. With the newest pnpm, the tool that installs those packages, it used to say only that installing failed.",
        prs: [561]
      }
    ],
    behindTheScenes: [
      "We updated the libraries Patchy is built on to their latest fixes.",
      "We now build Patchy with the newest version of its package manager."
    ]
  },
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
