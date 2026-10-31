/**
 * What's new: the changelog behind What's new in the sidebar and `/whats-new`. It ships with the
 * server, so production shows the releases its own commit carries, and a rollback shows the
 * older list. Its New and Improved changes are public too: patchyhq.com reads them from
 * `/whats-new.json`, without the PRs, `through` or behind-the-scenes lines.
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
 * - New and Improved changes reach the website too, so they must read well to anyone.
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
    id: 29,
    date: "2026-10-31",
    through: "5eeb1545ae83dacab543aa9e06e6bb2a107b4bb3",
    changes: [
      {
        kind: "New",
        title: "Pick up a patch someone else built",
        detail:
          "Your agent can now pull a copy of any patch you can open, with the files it was published from, ready to change and run. A patch handed to you, or a new laptop, no longer means starting over. Files kept out of git and .env files stay on the computer they came from. A patch built in a repo before today can be pulled once its owner publishes it again.",
        prs: [1003]
      },
      {
        kind: "Improved",
        title: "Publishing won't replace newer work",
        detail:
          "If someone published a newer version after your copy was made, publishing now stops and says so instead of replacing it. Your agent can pull the newest version and make the change there, or publish anyway when replacing it is what you meant.",
        prs: [1004]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 28,
    date: "2026-10-30",
    through: "ebbc21598f7821ceeef12f64fc46213a4bcb93cd",
    changes: [],
    behindTheScenes: [
      "Patchy can now keep the files of the repo each version was published from, the groundwork for pulling a patch back down to work on it."
    ]
  },
  {
    id: 27,
    date: "2026-10-30",
    through: "d285816c49b771baebb3c6528e245c7e70690d0a",
    changes: [
      {
        kind: "Fixed",
        title: "Your agent gets just the error when it mistypes a command",
        detail:
          "When your agent got an option wrong in a patchy command, patchy used to answer with a page of help as well as the error, which the agent could mistake for a result. Now it answers with just the error, naming the option to fix.",
        prs: [1073]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 26,
    date: "2026-10-30",
    through: "eabf2e6404258c03b7f1b4e43c067b98dd95cea5",
    changes: [],
    behindTheScenes: [
      "Older pages published from a single HTML file now run the same way as new ones, so Patchy has one kind of page instead of two."
    ]
  },
  {
    id: 25,
    date: "2026-10-29",
    through: "18b39ae57bd98a8091bfdea23b6a76f84404e145",
    changes: [
      {
        kind: "New",
        title: "Pages published from one HTML file can run script",
        detail:
          "A page your agent publishes from a single HTML file can now run its own script, so it can sort a table, switch tabs or draw a chart, and it can be up to 10 MiB. It still has to carry everything it shows: an image, font or stylesheet loaded from another address is refused at publish and named, so put it in the file instead, for example as a data: URL.",
        prs: [1045]
      },
      {
        kind: "Improved",
        title: "Pages and Tools sort by what a patch runs",
        detail:
          "On Home and All patches, a patch that runs only in your browser is now listed under Pages, and a patch with its own server code is listed under Tools.",
        prs: [1045]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 24,
    date: "2026-10-29",
    through: "9ee90e3a5d5aaa286fda468c550d1e6f154e1875",
    changes: [
      {
        kind: "Improved",
        title: "Company data goes through a patch's own rules",
        detail:
          "A patch that reads a company connection such as Postgres, PostHog, Pidgeon or Attio, another patch's shared data, or the member directory now does it from its server code, where the patch's rules hold and nobody viewing it can go around them. A patch that runs only in the browser reaches its own tables and files. One that already read any of these stops getting that data until it moves to server code, and Patchy tells your agent what to change.",
        prs: [1047]
      },
      {
        kind: "Fixed",
        title: "Plain pages no longer say they could not start",
        detail:
          "A page that doesn't use Patchy's code, such as hand-written HTML in a patch repo, was covered by \"This patch could not start\" after ten seconds. It now just shows.",
        prs: [1044]
      }
    ],
    behindTheScenes: []
  },
  {
    id: 23,
    date: "2026-10-29",
    through: "ed80fc7df41fb4f8c93120caa59d41ee0dd6d48a",
    changes: [
      {
        kind: "Improved",
        title: "Patches with server code open faster",
        detail:
          "When you land on Home or All patches, Patchy now gets your company's server and the three patches you open most ready in the background, so opening one is quick. A patch you just used stays ready for ten minutes instead of one, loading a patch onto its server takes about a third of the time it did, and each company's server has twice the processing power.",
        prs: [991, 992, 997, 999, 984]
      }
    ],
    behindTheScenes: [
      "Patchy can now run patches for more companies at the same time, so a busy day is less likely to leave anyone waiting for a free server."
    ]
  },
  {
    id: 22,
    date: "2026-10-29",
    through: "a2d133130d6dbd86df6d36c8e21254306d8c649a",
    changes: [
      {
        kind: "Improved",
        title: "Your agent checks patches several times faster",
        detail:
          "New patch repos now use TypeScript 7 and Oxlint, which check a patch several times faster, and the patchy download is about a third smaller. The next time you publish an existing repo, patchy asks you to move it over first and names the one command to run. Your published patches keep working the whole time.",
        prs: [989, 994, 1009, 1010]
      }
    ],
    behindTheScenes: [
      "Patchy itself now builds with TypeScript 7 and Oxlint, so its own checks run several times faster.",
      "Encryption, signing and ids all go through one place in Patchy now, with tests proving everything already stored still opens."
    ]
  },
  {
    id: 21,
    date: "2026-10-28",
    through: "f30d8fef1a615b41218f8e388359a483ab86a5e4",
    changes: [
      {
        kind: "New",
        title: "Patches can read your Attio CRM",
        detail:
          "If your company keeps its customers, deals and pipelines in Attio, an admin can connect the workspace from Integrations with a read-only key. Patches can then find, sort and open its records and lists, shaped to your own objects and fields, and nothing in Attio can be changed through Patchy. While your agent builds one, it reads your real CRM.",
        prs: [967, 968]
      }
    ],
    behindTheScenes: [
      "Patchy refuses an Attio key that can change anything, and stops using a connected key if it later gains that power."
    ]
  },
  {
    id: 20,
    date: "2026-10-28",
    through: "c5175bd033ed773f499368363c64ac8e9f9e9820",
    changes: [
      {
        kind: "New",
        title: "Patches can read and answer a company email address",
        detail:
          "If your company's mail runs through Pidgeon, an admin can connect one of its addresses from Integrations, choosing Read or Read and send. Patches can then read that inbox and, with Read and send, reply and send from it, up to 200 sends a day; mail Pidgeon holds for someone's approval shows as waiting, never as sent. While your agent builds one, it reads the real mail and sends nothing.",
        prs: [921, 954, 955]
      },
      {
        kind: "Fixed",
        title: "The patchy command survives a Node update",
        detail:
          "Switching Node versions, as tools like nvm and mise do, used to make the patchy command disappear. Run your install line once more and it moves somewhere that lasts; if your terminal can't find it there yet, the install line shows the one line to add.",
        prs: [944]
      }
    ],
    behindTheScenes: [
      "Patchy keeps only a key for the one connected email address, never your Pidgeon admin key."
    ]
  },
  {
    id: 19,
    date: "2026-10-25",
    through: "156a22858887452c3cd87ee70997912f2a536f31",
    changes: [
      {
        kind: "Improved",
        title: "A sidebar that keeps your things and the company's apart",
        detail:
          "Every page now has a sidebar: Home, All patches and Your agents, then your company's People, Integrations and Agent access. Search sits at the top, and What's new and your name, which opens Sign out, sit at the bottom. On a phone, Menu opens the same list. Pages are calmer too, with fewer heavy borders, shadows and badges.",
        prs: [930]
      },
      {
        kind: "Improved",
        title: "Your agents shows what's connected first",
        detail:
          "Your machines is now Your agents. It starts with the computers that publish as you and the apps that use your company's tools as you, each with a button to end it. Add a computer and Connect an app open the steps only when you want them, and Disconnect everything says what it ends and asks once before it does.",
        prs: [932]
      },
      {
        kind: "Improved",
        title: "People, Integrations and Agent access each have a page",
        detail:
          "The Company page is now People, with Invite people in its toolbar. Agent access has a page of its own that says what turning it off does before you do it, and the page for your company's databases and analytics is now called Integrations.",
        prs: [931]
      },
      {
        kind: "Improved",
        title: "Patches go by their real names, and one click opens them",
        detail:
          "Lists show a patch's title, like Spend Requests, instead of its short name, and clicking a patch opens it wherever it's listed. Its menu has About, Copy link and the rest.",
        prs: [933]
      },
      {
        kind: "New",
        title: "Patchy says what just happened",
        detail:
          "After you revoke a computer, invite someone, change who can open a patch or anything like it, a line at the top of the page says what was done.",
        prs: [930, 931, 932, 933]
      },
      {
        kind: "Improved",
        title: "Making a patch public asks first",
        detail:
          "Choosing Anyone on the internet now shows one step that says anyone with the link can open it without signing in, so nothing goes public by accident.",
        prs: [933]
      }
    ],
    behindTheScenes: [
      "Agents' instructions and Patchy's docs use the new page names, and send people to Agent access when an admin needs to turn it on."
    ]
  },
  {
    id: 18,
    date: "2026-10-24",
    through: "b23e6ad8fec8d052263a6f940d525428d7222de2",
    changes: [
      {
        kind: "New",
        title: "A Final step to connect your AI agent",
        detail:
          "Until your agent is connected, Home opens with a short Final step: give your agent one line, then confirm it's you. It follows along as your agent works, showing when it opened the line, when it's waiting for you and when it's connected, and if something goes wrong it says what happened and gives you a new line. It comes back each time you sign in, for your first week or your first three sign-ins, whichever lasts longer, and Later puts it away until next time.",
        prs: [916, 917]
      },
      {
        kind: "New",
        title: "Confirm your computer without leaving Home",
        detail:
          "When your agent asks to connect, the Final step shows its code and asks if it's yours. Check it against the code your agent shows, then confirm right there, with no second tab. If you didn't start it, Not me turns it away and nothing is connected.",
        prs: [918]
      },
      {
        kind: "Improved",
        title: "Setting up ends with your first page",
        detail:
          "When you set Patchy up with your AI agent, it now finishes by publishing a welcome page in your company's look, so you have something live straight away. Then it suggests a first tool to build, based on what it knows about your work.",
        prs: [914]
      },
      {
        kind: "Improved",
        title: "The logo takes you Home",
        detail:
          "Clicking the Patchy logo at the top of any page now takes you to Home, and Patches opens the full list of your company's patches.",
        prs: [913]
      }
    ],
    behindTheScenes: [
      "Patchy now notices the first time someone opens a colleague's tool, so we can tell whether new people find something useful in their first week."
    ]
  },
  {
    id: 17,
    date: "2026-10-23",
    through: "5dd94f381d3fae4c6957e76beceeb66b0ebec467",
    changes: [
      {
        kind: "New",
        title: "Your AI agent can use your company's tools",
        detail:
          "Connect Claude Code or Codex to Patchy once, with the steps on Your machines, and it can find your company's tools and read or change them for you. It reaches only a tool's agent tools, the parts made for agents, and it can't do anything you can't. Before it connects, Patchy asks you in your browser, showing what it will and won't be able to do.",
        prs: [873, 878, 880, 881, 882, 883, 884, 886, 887]
      },
      {
        kind: "New",
        title: "Admins choose whether agents can use the company's tools",
        detail:
          "Agent access, at the foot of the Company page, starts off. An admin turns it on to let everyone connect their own agent, or off to refuse every agent until it's back on, without ending anyone's connection. Everyone can see whether it's on and who changed it last.",
        prs: [871]
      },
      {
        kind: "Improved",
        title: "Your machines shows your agents too",
        detail:
          "Your machines now shows how to connect your agent, and lists the agents you've connected beside your computers, with when each was last used and a button to disconnect it. Revoke all machines is now Disconnect everything, at the foot of the page. It's always there, and it disconnects your agents as well as your computers.",
        prs: [885, 879]
      },
      {
        kind: "New",
        title: "See what agents can do with a tool",
        detail:
          "A tool's page now lists its agent tools beside the Overview, under What agents can do: what each one does and whether it reads or changes anything, with a link to connect your agent.",
        prs: [876]
      },
      {
        kind: "New",
        title: "The log says when an agent made a change",
        detail:
          "A tool's log now names agent work as the person via their agent, such as \"Jordan Lee via Claude\", so you can tell someone's own changes from their agent's. It shows in the Log tab, the tool's recent activity and the log your agent reads.",
        prs: [888]
      },
      {
        kind: "New",
        title: "Your agent can make a tool ready for agents",
        detail:
          "When your AI agent builds a tool with server code, it can now add agent tools: what people's agents may read and change in it, under the tool's own rules. It can try them on your computer before publishing, and publishing lists them and says if agent access is still off.",
        prs: [869, 870, 872, 875, 896]
      }
    ],
    behindTheScenes: [
      "Agents' calls to a tool have limits of their own, and a tool's server that only an agent is using rests a minute after its last call.",
      "The New and Improved changes in this list are now public, so patchyhq.com can show them too.",
      "We updated the libraries Patchy is built on to their latest fixes."
    ]
  },
  {
    id: 16,
    date: "2026-10-22",
    through: "dd3f41f26da57474bd53df564a8f8b8d3d029847",
    changes: [
      {
        kind: "Fixed",
        title: "Revoke all machines stops logins still on their way",
        detail:
          "A login you had approved in the browser could still finish on its computer after you pressed Revoke all machines on Your machines. Now Revoke all machines cancels it too, and so does deactivating someone.",
        prs: [867]
      }
    ],
    behindTheScenes: [
      "Patchy keeps two more company addresses, mcp and oauth, for its own use.",
      "Patchy already understands, and enforces, tools' parts that only read and parts made for agents, so going back to this version stays safe once tools start using them.",
      "Patchy's own logs record how long a tool's server takes to start."
    ]
  },
  {
    id: 15,
    date: "2026-10-19",
    through: "9e4b0dfc8f5868035c8c40821b28145a4abbd804",
    changes: [
      {
        kind: "New",
        title: "Your agent can read a tool's log",
        detail:
          "When a tool your agent published goes wrong, the agent can now read the tool's log itself, errors included, instead of you copying them out of the Log tab. Ask it to look at what happened, fix the tool and publish again. It sees the same log you do as the tool's owner or a company admin.",
        prs: [786]
      },
      {
        kind: "Fixed",
        title: "Tools with server code keep one steady connection",
        detail:
          "Opening a tool with server code sometimes dropped its live connection a moment later and set it up again, which held up its data. It now stays connected from the start.",
        prs: [798]
      }
    ],
    behindTheScenes: [
      "A tool left open but unused no longer keeps its server running all the time. After a while the server rests, and it starts again when you next use the tool."
    ]
  },
  {
    id: 14,
    date: "2026-10-19",
    through: "7694babf056f355ba9cd0e239febfd1cae907d7a",
    changes: [
      {
        kind: "Improved",
        title: "Tools with server code answer faster",
        detail:
          "A tool your agent built with server code now keeps its server ready while you have it open, so switching screens or saving after a pause no longer waits for it to start again. Each call also does less work before it reaches your data, and a screen runs two of its lookups at once instead of one after another.",
        prs: [756, 764, 768, 769, 771, 772, 773, 775, 778]
      },
      {
        kind: "Improved",
        title: "Your company's tools and pages open sooner",
        detail:
          "Opening a tool or page no longer waits for Patchy to check who you are before it starts loading its data. Its files come from memory and arrive compressed, and the parts every tool shares stay in your browser between visits.",
        prs: [759, 761, 766, 770]
      },
      {
        kind: "Fixed",
        title: "Tools stop flashing Reconnecting while they load",
        detail:
          "A tool with several slow lookups used to show Reconnecting and ask for its data again while it was still loading. It now waits for the answers, picks a lost connection back up at once, and backs off calmly when it can't.",
        prs: [755, 776, 780]
      },
      {
        kind: "Improved",
        title: "Publishing is quicker",
        detail:
          "When your agent publishes a tool that uses your company's look, Patchy checks the look is current without downloading all of it first.",
        prs: [729]
      },
      {
        kind: "Improved",
        title: "New tools start with a tidy layout",
        detail:
          "A tool your agent starts now opens as a centred column with room around it, instead of text pressed into the top-left corner.",
        prs: [763]
      },
      {
        kind: "Improved",
        title: "Your usual is easier to scan",
        detail:
          "The patches in Your usual on Home now show just their name and why they're there. On a mid-sized window, Home's rows fit their column instead of breaking names across lines.",
        prs: [721]
      },
      {
        kind: "Fixed",
        title: "A page that isn't there says what to do",
        detail:
          "An address that doesn't lead anywhere now shows a full-page notice like the rest of Patchy, with a link back to Home.",
        prs: [762]
      },
      {
        kind: "Fixed",
        title: "A logo Patchy can't read is refused, not a crash",
        detail:
          "If a company logo has text Patchy can't check, publishing the look now says which part to fix instead of failing with an unexpected error.",
        prs: [728]
      }
    ],
    behindTheScenes: [
      "Patchy's own logs record more about how tools keep their live data up to date, to find what's still slow."
    ]
  },
  {
    id: 13,
    date: "2026-10-16",
    through: "c9b8fc48622ddff2a02251f4415dcbbcbe841ec6",
    changes: [
      {
        kind: "New",
        title: "Home puts the patches you use first",
        detail:
          "Signing in now opens Home. Your usual shows the four patches you open most, so you're one click from them, then come your company's tools and its pages, with new pages marked until you read them. Search covers every patch by name, what it does or who made it, and when nothing matches, Home gives you a line to ask your AI agent to build it.",
        prs: [713, 716, 719]
      },
      {
        kind: "New",
        title: "Every patch in one list",
        detail:
          "All patches lists everything your company has published, with tabs for tools, pages, your own, and retired and deleted ones, plus a search. Each row's menu holds its actions. Owners and admins also get a Needs attention tab for patches whose owner has left or that are about to be deleted for good.",
        prs: [715]
      },
      {
        kind: "Improved",
        title: "Each patch's page leads with Open",
        detail:
          "A patch's page now starts with Open and its address, then tabs: Overview and Versions for everyone, and Log and Settings for its owner and admins. Settings holds the description, who can open it, and retiring or deleting it.",
        prs: [717]
      },
      {
        kind: "New",
        title: "See when your tools are failing",
        detail:
          "If a tool you own with server code had calls fail in the last day, Home tells you which, with a link to the failures in its log. Owners and admins also see each tool's health in All patches.",
        prs: [718]
      },
      {
        kind: "Fixed",
        title: "Everyone has a name",
        detail:
          'People who signed up with only an email used to show as a blank name in Patchy, as in "Description edited by on…". They now go by the first part of their email until they set a name.',
        prs: [687]
      },
      {
        kind: "Improved",
        title: "Your company's look is easier to get right",
        detail:
          "When your agent previews a first company look, it can now compare it with the look your tools use today, both shown whole in one screenshot. A logo that browsers can't show is refused when the look is published instead of appearing broken in every tool. Restoring an earlier look now records who restored it and why.",
        prs: [697, 696, 703, 688]
      },
      {
        kind: "Improved",
        title: "Forms follow your look's error states",
        detail:
          "Tools your agent builds now show a field with a problem, and a disabled one, the way your company's look styles them. The example looks your agent learns from got the same fix.",
        prs: [691, 692]
      },
      {
        kind: "Improved",
        title: "Clearer answers when a publish goes wrong",
        detail:
          "When a page can't be built because something it uses is missing, your agent is told exactly what. A page whose font or stylesheet won't load is published with a note naming it, and a file too big to save says so.",
        prs: [686, 685, 689]
      },
      {
        kind: "Fixed",
        title: "Your agent's Patchy commands are steadier",
        detail:
          "An update to a tool's project that was cut off halfway no longer locks it. Previewing a tool on your computer no longer crashes on Node.js 24, it says when it's joining a preview already running, and every command's help explains each option.",
        prs: [695, 704, 680, 681]
      }
    ],
    behindTheScenes: [
      "Patchy checks static pages and tools' database requests more strictly, and logs a malformed request instead of failing it silently.",
      "Patchy's own usage numbers now count every publish, sharing change and restore, and keep less of what a tool imports."
    ]
  },
  {
    id: 12,
    date: "2026-10-15",
    through: "b58b8996619cfaf48670e3a86d5555bb680e7f25",
    changes: [
      {
        kind: "Fixed",
        title: "Links within a page jump to their section",
        detail:
          "On a page your agent publishes, a table of contents or a back-to-top link now scrolls to its section. Clicking one used to blank the page and show a browser error instead. Pages already published work now, with nothing to republish.",
        prs: [677]
      },
      {
        kind: "Improved",
        title: "Set up Patchy however you ask",
        detail:
          "Your AI agent now sets Patchy up on your computer whatever words you use, not only the line from the guide, and still sets up your company's look. If you give your agent nothing but Patchy's address, the sign-in page now shows it the line to start from, so it no longer has to guess.",
        prs: [672, 674]
      },
      {
        kind: "Improved",
        title: "Claude Code can know Patchy is your company's own",
        detail:
          "If you use Claude Code, setting up Patchy now offers to tell its auto mode that Patchy is your company's own service, so it doesn't treat publishing a page as sending it outside the company. It asks you first, applies to all your projects and can be undone. If auto mode still stops a publish, your agent explains why and asks you what to do.",
        prs: [676]
      },
      {
        kind: "Fixed",
        title: "Your agent remembers Patchy after a Node.js update",
        detail:
          "Patchy's instructions for your AI agent now live in your home folder, so switching or removing a version of Node.js no longer makes your agent forget Patchy. If the patchy command itself goes missing, your agent reinstalls it from your company's Patchy.",
        prs: [673]
      },
      {
        kind: "Fixed",
        title: "Sign-in codes say how many minutes they have left",
        detail:
          "When your agent signs you in on a new computer, it now tells you how many minutes the code has left, instead of a time that could be in another time zone.",
        prs: [675]
      }
    ],
    behindTheScenes: [
      "Patchy checks uploaded pages and logos within strict limits, so one unusual upload can't slow Patchy down for everyone."
    ]
  },
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
