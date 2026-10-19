# Portal

Where a signed-in person finds and manages their company's patches. The patch, its states and its owner belong to [Patches](../patches/GLOSSARY.md); the viewer to [Auth](../auth/GLOSSARY.md); users and roles to [Companies](../companies/GLOSSARY.md).

## Language

**Portal**:
Where a signed-in person finds and manages their company's patches: Home at `/`, All patches at `/patches`, each patch's card and the guide. It lists only the viewer's own company, public patches included, and never another company's.
_Avoid_: dashboard, directory

**Home**:
The signed-in landing at `/`, for opening patches rather than managing them: a search over every live patch, **Your usual**, **Tools** and **Pages**, with a way to All patches and to what is off. With nothing live and nothing of the viewer's own, Home is the guide. A search that matches nothing offers a line to hand an agent, built from the query. An owner whose tier 2 patches failed in the last day sees them named at its top, each linked to its failed log entries.
_Avoid_: dashboard, landing, index (the alphabetical list beside the card it replaced), home page (the root is a sign-in door when signed out)

**Your usual**:
Home's first shelf: the four live patches the viewer opened most in the last 30 days, by their opens' halving score, padded with the company's most-visited. With no opens yet it is titled "Popular at" the company. Its tiles carry only the mark and name, since the viewer already knows them. It reads only the viewer's own opens.
_Avoid_: favourites, pinned (pins are not built), recent

**Tools** and **Pages**:
Home's split of live patches by their current version's tier: **Tools** are tiers 1 and 2, opened and used; **Pages** are tier 0, read and passed around. A republish that changes the tier moves the patch. Pages **new to you** are a colleague's company-scope pages published in the last week that the viewer hasn't opened since; a public page never claims to be unread, since opening it records nothing.
_Avoid_: apps, documents, docs, kinds (nothing is declared; the tier decides)

**All patches**:
The table at `/patches` of every patch the viewer can open: tabs for All, Tools (tiers 1 and 2), Pages (tier 0), Yours, Needs attention and Retired and deleted, a search over name, title, description and owner, and each row's acts in its menu. **Needs attention** lists a patch only to its owner and admins: an admin sees live patches whose owner is deactivated, and both see deletions within a week of reclamation, each with the act that resolves it. For the tier 2 patches a viewer manages, a **Health** column shows the last day's failed calls, counted as the log's Failed filter counts them, and Needs attention lists any that failed.
_Avoid_: dashboard, directory, admin list

**Card**:
One patch's page at `/patches/<name>`, in tabs: **Overview** (its description, owner, current version, who can open it, what reads it, its visits and recent activity), **Log** and **Settings** for its owner and admins, and **Versions**. Its header leads with Open, or Restore for a manager while an off patch can be restored. The portal owns the card's browser admission and 32-character name bound; the patch itself lives at its address.
_Avoid_: patch page (the patch is the page at the address), detail view, dossier

**Log**:
The card's tab at `/patches/<name>/log` for its current owner and admins: its logged invocations newest first, each expanding into the calls it made and its `ctx.log` lines, filtered and paged. It is an attribution record of who ran what as whom, not an access audit; the log lines are the patch's own words. The card's **Recent activity** shows the last three entries. Runtime owns the record; the portal and `patchy logs` only read it.
_Avoid_: audit log, activity feed, call log (Integrations' per-connection list)

**Guide**:
**Your first patch** at `/guide`, reached from Home's **Make your own** while the viewer owns no patch, and Home itself while nothing is live: what Patchy is, then the steps from the setup line to a first publish, each with a preview of what the agent will say. Its progress comes from the viewer's live machine tokens and owned patches, never a stored checklist, and owning any patch ends it: `/guide` then sends its owner Home.
_Avoid_: onboarding (the global skill's welcome page is that), tutorial, checklist, wizard

**Settings**:
The card's tab at `/patches/<name>/settings` for its owner and admins: the owner with admin-only Reassign…, the description, who can open it, and Retire… and Delete…. The served version changes on Versions and an uncomplicated restore from the card's header. Retire, delete, restore with off sources and reassign lead to confirmation pages. A refused form shows the tab it sits on; a refusal of who may act, or of a form whose name now names another patch, shows Overview.
_Avoid_: manage, admin panel, edit mode

**Confirmation page**:
The page for an act that breaks another tool or that the actor cannot undo alone: the consequence, what breaks, the acknowledgement and the way back. Patch management confirmations live under the card's URL; deactivation and reactivation confirmations follow the user's pick page and describe the exact selection.
_Avoid_: modal, dialog, are-you-sure

**Acknowledgement**:
The actor's explicit acceptance, on a confirmation page, of the breakage to listed dependants or the errors a restored patch encounters when reading off sources; absent when nothing breaks. In the CLI its counterpart is `--force`.
_Avoid_: consent, override, warning (what precedes it)

**Pick page**:
The deactivation or reactivation step that lists a user's patches for the admin to leave alone, act on a selection, or act on all. Deactivation shows each live patch's dependants; confirmation excludes dependants or restored sources inside the selection.
_Avoid_: bulk action, checklist, wizard

**Stale action**:
An act posted from a page whose patch has since changed in the way the act depends on. It is refused with nothing done, and the card re-renders naming who did what.
_Avoid_: conflict, optimistic lock, revision mismatch

**App shell**:
The shared frame for the portal, Company, Connections and Your machines: the header bar with sections, the What's new bell, viewer and sign-out, over the page. Sign-in, create-or-join, device confirmation and error doors keep the card shell; portal not-found pages keep the app shell.
_Avoid_: layout, template, theme

**Component set**:
The built vocabulary of controls every first-party page composes: buttons, fields, fact lists, compact selectable lists and trees, placeholder rows, version tables and expandable table rows, copyable addresses and copy lines, notices, headings, pills, confirmation forms and the guide's steps, flow and agent previews, styled once in the shell so they look and scale the same everywhere. Page styles carry layout only; patches are exempt.
_Avoid_: design system (there is one theme and no library), component library, utility classes

**What's new**:
Patchy's changelog for the people using it, at `/whats-new` and behind the app shell's bell: one **release** per deploy, written before it from the PRs merged since the last, each holding **changes** tagged New, Improved or Fixed and a few behind-the-scenes lines. A person's **seen marker** is the newest release they have looked at; opening the bell or the page raises it, and a new member starts at the newest. The list ships with the server in `@patchy/core`, so a rollback shows the older one.
_Avoid_: notifications (nothing is addressed to one person), release notes (the notes are what the deploying agent writes, not the page), updates
