# Portal

Where a signed-in person finds and manages their company's patches. The patch, its states and its owner belong to [Patches](../patches/CONTEXT.md); the viewer to [Auth](../auth/CONTEXT.md); users and roles to [Companies](../companies/CONTEXT.md).

## Language

**Portal**:
The signed-in landing at `/`: the company's patches on one side and one patch's card on the other. It lists only the viewer's own company, public patches included, and never another company's.
_Avoid_: dashboard, home page (the root is a sign-in door when signed out), directory (the index is one half of it)

**Index**:
The compact list of the company's patches beside the card: name and the first clause of the description, grouped as the viewer's own, the company's, and retired and deleted behind a toggle.
_Avoid_: sidebar, list (the CLI's `patchy list` is discovery, not this), table

**Card**:
One patch's page at `/patches/<name>`: its address, description, owner, current version, who can open it and what reads it, with the management acts for whoever may perform them. The card describes and manages the patch; the patch itself lives at its address.
_Avoid_: patch page (the patch is the page at the address), detail view, dossier

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
The shared frame for the portal, Company, Connections and Your machines: the header bar with sections, viewer and sign-out, over the page. Sign-in, create-or-join, device confirmation and error doors keep the card shell; portal not-found pages keep the app shell.
_Avoid_: layout, template, theme

**Component set**:
The built vocabulary of controls every first-party page composes: buttons, fields, fact lists, compact selectable lists, version tables, copyable addresses, notices, headings, pills and confirmation forms, styled once in the shell so they look and scale the same everywhere. Page styles carry layout only; patches are exempt.
_Avoid_: design system (there is one theme and no library), component library, utility classes
