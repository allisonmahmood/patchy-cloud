# Portal

Where a signed-in person finds and manages their company's patches. The patch, its states and its owner belong to [Patches](../patches/GLOSSARY.md); the viewer to [Auth](../auth/GLOSSARY.md); users and roles to [Companies](../companies/GLOSSARY.md).

## Language

**Portal**:
Where a signed-in person finds and manages their company's patches: Home at `/`, All patches at `/patches`, each patch's card and the guide. It lists only the viewer's own company, public patches included, and never another company's.
_Avoid_: dashboard, directory

**Home**:
The signed-in landing at `/`, in the order people come for: **Needs attention**, **Your usual**, **New**, **Yours**, **From colleagues** and **Shared with you**. Each patch is called by its title, less a trailing company name as everywhere Patchy names a patch, and opened by it, and its menu holds About this patch. Below eight live patches Home reads whole, without Your usual and New. Its one or two notices come first: for a day after someone's first publication, "<title> is live" with Open and Copy link, and, until the viewer connects an agent and while the Final step isn't over it, Connect your agent, leading to `/guide`. Search lives on All patches, so `/?q=` goes to `/patches?q=`. `/?new` opens **New patch** over it. A company with nothing live says so in Home's place, with Shared with you after it.
_Avoid_: dashboard, landing, index (the alphabetical list beside the card it replaced), home page (the root is a sign-in door when signed out)

**Needs attention** (Home):
Home's first section, shown only when something is wrong, each row saying what broke and holding the one action that fixes it: the viewer's own tools that failed in the last 24 hours, with View log, for admins the company's connections that need one, in Integrations' words, with their fix, and the viewer's own apps and computers whose access ended on its own in the last 30 days, as Your agents lists them, with Reconnect to Connect an app (that app chosen) or Add a computer. While a computer is there, Home leaves out Connect your agent. A connection is there when its provider stopped it (an Attio key found writable, an IMAP login the mail server refused), when Pidgeon still holds a key Patchy couldn't revoke, when live patches use a Pidgeon test key, or when an admin disconnected it while live patches still declare it. All patches' Needs attention is its own list.
_Avoid_: alerts, warnings, inbox

**Your usual**:
Up to four tiles of the live patches the viewer opened most in the last 30 days, by their opens' halving score, and nothing else. Reopening a patch within ten minutes counts once, so flipping between two patches doesn't take it over. With no opens yet it is titled "Popular at" the company and holds the company's most-visited. A tile carries the mark, the title, and whether it is a tool or a page and whose. It reads only the viewer's own opens.
_Avoid_: favourites, pinned (pins are not built), recent

**New** (Home):
Up to three of colleagues' patches made in the last week that the viewer hasn't opened, newest first, each with Open in a new tab and the [not opened yet](#not-opened-yet) dot. A public page is never new, since reading it signed out records no open.
_Avoid_: unread, recent, latest

**Yours** and **From colleagues**:
Home's two tables of live patches, A–Z and never re-sorted. **Yours** holds the viewer's own, with who can open each (Company, Company and its guests, or Public), the call summary for tools (None, No calls yet or how many failed in 24 hours) and Share on every row, which opens the Share dialog over Home. **From colleagues** holds everyone else's, with owner and when it last changed and the [not opened yet](#not-opened-yet) dot, the first twelve, and See all on All patches. A phone keeps the title and menu, and a failing tool's count under its title. Core's `isPage` tells a tool (tier 2) from a page (tier 1), for the mark and the welcome page alike.
_Avoid_: shelves, apps, documents, kinds (nothing is declared; the tier decides)

**Shared with you**:
Home's last section, of other companies' patches shared with the viewer as their [guest](../companies/GLOSSARY.md), each with its company and who shared it: each opens the patch, or, while its guests can't open it, says why, and one the viewer can open but never has carries the [not opened yet](#not-opened-yet) dot, unless it is public; its menu holds **Remove…**, which asks on a confirmation page and then ends the viewer's own grant. It stays when the company has nothing live.
_Avoid_: shared patches, guest patches, inbox

**Not opened yet**:
The blue dot after the name of a live patch someone else owns that the viewer has no [open](../patches/GLOSSARY.md) of, like unread mail, on All patches under every filter and search and on Home in New, From colleagues and Shared with you; never on Yours, Your usual or the switcher. Opening the patch at its address clears it. Each page reads the viewer's opens once.
_Avoid_: new, unread, unseen (What's new's dot marks changes, not patches)

**Switcher**:
Patchy's own **Go to…** menu on Mod+Shift+K, over any company patch the person can open, a guest's view of a shared patch and their own company's public patches included, every signed-in portal page, and every notice that stops a signed-in person; never on a public patch's page for anyone outside its company, a signed-out person's notice or in `patchy dev`, which only claim the key. Nothing typed, it lists the patch they were last in first and lit, so the key then Enter flips back, the next five they opened last, then patches they have never opened, the company's before those shared with them, six patches in all (with nothing to flip back to, none of them is lit), **This patch** (the card's Overview and Versions, with Log and Settings for its owner and admins, never for a guest) and **Patchy**, the places with What's new. Typing filters it all by word starts, initials, and from three letters inside a word. It opens at once from the tab's copy of the [switcher list](#switcher-list), which each page load and an open after a minute refresh and signing out forgets; Escape or the key again closes it and puts the cursor back. There is no button for it.
_Avoid_: command palette (it runs no commands), launcher, quick open, spotlight

**Switcher list**:
What `/switcher.json` answers a signed-in person's browser, for the switcher's menu: their company's live patches they can open, public ones included, each saying whether it is theirs and when they last opened it, and the patches shared with them that they can open now and that aren't public. A grant outlives its patch going public and back, so a shared patch drops out while it is public, and another company's public patch never appears. Only a script on a Patchy page gets it, by the browser's session; another site, a machine token, or someone signed out or deactivated gets a JSON refusal. It is not part of the agents' API.
_Avoid_: patch index, directory, menu API

**Share dialog**:
The dialog over Home, All patches or a card where the owner or an admin shares a live patch, opened by Share on a row they own or in a card's header, **Share…** in a row's menu or `?share=<name>`: an email field to invite a guest, suggesting people the company has shared with before; the people with access, its owner and its guests with Remove, and why its guests can't open it while they can't; general access, People at the company or Anyone on the internet, where going public asks again before it applies and a tool says why it stays in the company; then Copy link and Done. Each form posts and comes back to the same page with the dialog open and its receipt inside, the Log tab's to Overview; a refused email shows under the field, kept. While a patch is public its guests keep their grants for its way back, and inviting waits. It is the one place who can open a patch changes in the portal.
_Avoid_: share page, sharing settings, invite

**All patches**:
The table at `/patches` of every patch the viewer can open, A–Z by title, 50 to a page (`?page=`): a filter for All, Tools (tier 2), Pages (tier 1) and Yours, with Needs attention and Retired and deleted while they hold something, each its own `?show=` address. The sidebar's search lands here as `?q=`, over name, title, description and owner, and shows as a chip that clears it; People's See their patches lands here as `?owner=<user id>`, one member's own patches exactly, shown as an Owner chip that clears it; the filter's counts are what it finds, and finding no live patch offers the line `Build us a Patchy tool for <query>` to hand an agent. A row opens its patch from anywhere on it, or an off one's card; Owner says You for the viewer's own, the viewer's own live patches carry Share, and a colleague's they haven't opened carries the [not opened yet](#not-opened-yet) dot. Each row's other acts are in its menu, About this patch and, for a live patch the viewer manages, Share… among them. **Needs attention** lists a patch only to its owner and admins: an admin sees live patches whose owner is deactivated, and both see deletions within a week of reclamation, failing tools and patches whose guests are turned away, each with the act that resolves it. For the tier 2 patches a viewer manages, **Failures (24 h)** reads the [call summary](#call-summary): None, No calls yet, or "2 failed" linked to the log filtered to Failed; a dash marks a row with no calls to count, and the column never says a tool is healthy.
_Avoid_: dashboard, directory, admin list

**Call summary**:
For each live tier 2 patch the viewer manages, its calls in the last 24 hours and how many of them failed, read from the runtime log's top-level entries and counted as its Failed filter counts them. A patch nobody called has none and none, so a page can tell No calls yet from no failures. A member who manages none never reads it. Home and All patches name failures from it.
_Avoid_: health check, uptime, status

**Card**:
One patch's page at `/patches/<name>`, one header over its tabs: **Overview** (its description, owner, who can open it, current version, opens, what reads it and recent activity), **Log** and **Settings** for its owner and admins, and **Versions**, where the served version says Serving. The header holds the patch's mark, its title (less a trailing company name), its kind and address with Copy, a **status line** only when there is something to say (retired or deleted, by whom, when and until when; the last 24 hours' failed calls on Overview; an owner who is deactivated, to admins), and Share for a manager and Open, or Restore while an off patch can come back, beside a menu of Open in a new tab, Copy link and, for a manager, Retire… and Delete…. Beside the Overview of a live patch whose current version has agent tools, **Your agent can, as you** shows everyone each tool, whether it reads or changes, and the first clause of what it says it does. The portal owns the card's browser admission and 32-character name bound; the patch itself lives at its address.
_Avoid_: patch page (the patch is the page at the address), detail view, dossier

**Log**:
The card's tab at `/patches/<name>/log` for its current owner and admins: its logged invocations newest first under their UTC day, each expanding into the calls it made and its `ctx.log` lines, filtered by Outcome, Person and Handler chips whose choices are links, and paged. It is an attribution record of who ran what as whom, not an access audit; the log lines are the patch's own words. The card's **Recent activity** shows the last three entries. Runtime owns the record; the portal and `patchy logs` only read it.
_Avoid_: audit log, activity feed, call log (Integrations' per-connection list)

**Guide**:
The **Final step**: connecting an agent, the last step between a person and Patchy, in two steps, giving the agent the setup line and confirming its code. It is a dialog over Home until the viewer has a live machine token, for their first week or first three sign-ins, whichever lasts longer, with **Later** as its only way out for the rest of a sign-in; a phone says the step happens on a computer, with Send this to my computer, and words Later "Look around <company> first". Home's **Connect your agent** leads to it as a page at `/guide`, and **New patch** holds the same steps from the same state. Its progress comes from the viewer's live machine tokens and their patches' publications, never a stored checklist; connected, `/guide` sends them Home.
_Avoid_: onboarding (the global skill's welcome page is that), tutorial, checklist, wizard

**New patch**:
The dialog over Home at `/?new`, which the sidebar's New patch opens: the line someone gives their agent. Connected, a starter line to copy and the computer their agent builds on; not yet, the Final step's two steps.
_Avoid_: create, new project, wizard

**Settings**:
The card's tab at `/patches/<name>/settings` for its owner and admins: the description, its own form; the owner with admin-only Reassign…; who can open it, whose Change… opens the Share dialog; and last **Take it down**, with Retire… and Delete…. The served version changes on Versions and an uncomplicated restore from the card's header. Retire, delete, restore with off sources, reassign and serving another version ask in a [confirmation](#confirmation) over their tab. A done act lands with a receipt naming it. A refused form shows the tab or dialog it sits on; a refusal of who may act, or of a form whose name now names another patch, shows Overview.
_Avoid_: manage, admin panel, edit mode

**Confirmation**:
The step before an act that breaks another tool or that the actor cannot undo alone: the consequence, what breaks, the acknowledgement and the way back. On a card it is a dialog over the tab the act sits on, at the act's own URL under the card's (`/patches/<name>/retire`, `/delete`, `/restore`, `/reassign`, `/rollback?version=<n>`), drawn again with the refusal when one is refused; a guest's Remove… and deactivation and reactivation are pages, the latter following the user's pick page and describing the exact selection.
_Avoid_: modal, are-you-sure

**Acknowledgement**:
The actor's explicit acceptance, in a confirmation, of the breakage to listed dependants or the errors a restored patch encounters when reading off sources: pressing the act of a card's dialog that names them, or ticking the box on a deactivation's page; absent when nothing breaks. In the CLI its counterpart is `--force`.
_Avoid_: consent, override, warning (what precedes it)

**Pick page**:
The deactivation or reactivation Flow page where the admin chooses to leave a user's patches alone, act on some, or act on all, over the list of them. Deactivation shows each live patch's dependants; confirmation excludes dependants or restored sources inside the selection.
_Avoid_: bulk action, checklist, wizard

**Stale action**:
An act posted from a page whose patch has since changed in the way the act depends on. It is refused with nothing done, and the card re-renders naming who did what.
_Avoid_: conflict, optimistic lock, revision mismatch

**App shell**:
The shared frame for the portal, People, Integrations, Agent access and Your agents: a sidebar with the patch search, New patch, the places (Home, All patches, Your agents and Settings, which holds People, Integrations and Agent access), What's new, Tell Patchy and the account menu, beside the page; below 1024px, a top bar whose Menu opens the same. Sign-in, create-or-join, device confirmation and error doors keep the card shell; portal not-found pages keep the app shell.
_Avoid_: layout, template, theme

**Component set**:
The one set of parts every first-party page composes, in core: the tokens, typed helpers (buttons, fields, notices, badges, rows, tables, menus, dialogs, steps, marks and the rest) and five page templates, Index, Detail, Settings, Flow and Door. A page fills a template's slots and carries no styles of its own; `pnpm check` holds the stylesheet to its tokens and pages to the helpers, and the development-only gallery at `/~ui` draws every part in its states. Patches are exempt.
_Avoid_: design system (there is one theme and no library), component library, utility classes

**What's new**:
Patchy's changelog for the people using it, a page per month at `/whats-new/YYYY-MM` with the newest at `/whats-new`, and behind What's new at the foot of the sidebar: one **release** per deploy, written before it from the PRs merged since the last, each holding **changes** tagged New, Improved or Fixed and a few behind-the-scenes lines. A person's **seen marker** is the newest release they have looked at; opening its panel or the newest month raises it, and a new member starts at the newest. A change's **permalink** is its month's page opened at it, named by its release and its place there. The list ships with the server in `@patchy/core`, so a rollback shows the older one. Its New and Improved changes are public at `/whats-new.json`, which patchyhq.com reads; Fixed changes and behind-the-scenes lines stay in the app. A release's **patch changes**, written for agents, say how it can make a patch built before it build or behave differently; refresh lists them to the agent moving a patch repo across it, and they appear nowhere else.
_Avoid_: notifications (nothing is addressed to one person), release notes (the notes are what the deploying agent writes, not the page), updates

**Tell Patchy**:
The sidebar foot's panel, between What's new and the account and in What's new's frame, for sending Patchy a [request or feedback](../feedback/GLOSSARY.md) from the dashboard: Request or Feedback, one text field, then the receipt and, for a request, its similar requests with **Same need** and Unlink. A long request's first line or opening words are its title and the whole text its why. A page's own button opens it beside itself, as Integrations' Ask for an integration does with Request picked.
_Avoid_: feedback form, contact, support

**What you sent**:
The table at `/feedback` of everything the person and their agents sent Patchy, newest first and paged: when, what, from whom through which surface, and a request's status, with Unlink and Withdraw… in each row's menu. It is how a person sees and takes back what an agent sent, and where Patchy MCP's answers point. It lights no place: Tell Patchy opens its panel, not this page.
_Avoid_: inbox, history, my requests, submissions (the store's word)
