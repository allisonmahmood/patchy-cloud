# Portal

Where a signed-in person finds and manages their company's patches. The patch, its states and its owner belong to [Patches](../patches/GLOSSARY.md); the viewer to [Auth](../auth/GLOSSARY.md); users and roles to [Companies](../companies/GLOSSARY.md).

## Language

**Portal**:
The signed-in landing at `/`: the company's patches on one side and one patch's card, or the guide, on the other. It lists only the viewer's own company, public patches included, and never another company's.
_Avoid_: dashboard, home page (the root is a sign-in door when signed out), directory (the index is one half of it)

**Index**:
The compact list of the company's patches beside the card: name and the first clause of the description, grouped as the viewer's own, the company's, and retired and deleted behind a toggle.
_Avoid_: sidebar, list (the CLI's `patchy list` is discovery, not this), table

**Card**:
One patch's page at `/patches/<name>`: its address, description, owner, current version, who can open it and what reads it, with the management acts for whoever may perform them. The portal owns the card's browser admission and 32-character name bound; the patch itself lives at its address.
_Avoid_: patch page (the patch is the page at the address), detail view, dossier

**Log**:
One patch's page at `/patches/<name>/log` for its current owner and admins: its logged invocations newest first, each expanding into the calls it made and its `ctx.log` lines, filtered and paged. It is an attribution record of who ran what as whom, not an access audit; the log lines are the patch's own words. The card's **Recent activity** shows the last three entries. Runtime owns the record; the portal only reads it.
_Avoid_: audit log, activity feed, call log (Integrations' per-connection list)

**Guide**:
The card for **Your first patch**, the index row that leads Yours until the viewer owns a patch: what Patchy is, then the steps from the setup line to a first publish, each with a preview of what the agent will say. Its progress comes from the viewer's live machine tokens and owned patches, never a stored checklist, and owning any patch ends it.
_Avoid_: onboarding (the global skill's welcome page is that), tutorial, checklist, wizard

**Manage**:
The owner or admin's controls on a card: description, who can open it, served version and uncomplicated restore stay inline. Retire, delete, restore with off sources and admin-only reassign lead to confirmation pages.
_Avoid_: settings, admin panel, edit mode

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
