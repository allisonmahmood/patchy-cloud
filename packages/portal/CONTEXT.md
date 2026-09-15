# Portal

Where a signed-in person finds and manages their company's patches. The patch, its states and its owner belong to [Patches](../patches/CONTEXT.md); the viewer to [Auth](../auth/CONTEXT.md); users and roles to [Companies](../companies/CONTEXT.md). The portal, index, cards, inline management, versions and stale-action refusals are built. Destructive confirmations and deactivation/reactivation choices remain decided work from [#247](https://github.com/allisonmahmood/patchy-cloud/issues/247).

## Language

**Portal**:
The signed-in landing at `/`: the company's patches on one side and one patch's card on the other. It lists only the viewer's own company, public patches included, and never another company's.
_Avoid_: dashboard, home page (the root is a sign-in door when signed out), directory (the index is one half of it)

**Index**:
The compact list of the company's patches beside the card: name and the first clause of the description, grouped as the viewer's own, the company's, and retired and deleted behind a toggle.
_Avoid_: sidebar, list (the CLI's `patchy list` is discovery, not this), table

**Card**:
One patch's page at `/patches/<name>`: its address, description, owner, current version, who can open it and what reads it, with the management acts for whoever may perform them. The card is catalog plus manage, never the patch itself, which lives at its address.
_Avoid_: patch page (the patch is the page at the address), detail view, dossier

**Manage**:
The owner or admin's controls on a card: description, who can open it, served version and restore are built inline. Retire, delete, restore with off sources and reassign lead to the decided confirmation pages, which are not yet built.
_Avoid_: settings, admin panel, edit mode

**Confirmation page**:
The decided page under a card's URL for an act that breaks someone else's tool or that the actor cannot undo alone: the consequence, what breaks, the acknowledgement and the way back. These pages are not yet built; an inline restore that discovers off sources displays their warning without performing the act.
_Avoid_: modal, dialog, are-you-sure

**Acknowledgement**:
The actor's explicit acceptance, on a confirmation page, of the breakage an act causes to listed dependants; absent when nothing breaks. In the CLI its counterpart is `--force`.
_Avoid_: consent, override, warning (what precedes it)

**Pick page**:
The decided, not-yet-built deactivation or reactivation step that lists a user's patches with what each depends on, for the admin to leave alone, act on a selection, or act on all before confirmation.
_Avoid_: bulk action, checklist, wizard

**Stale action**:
An act posted from a page whose patch has since changed in the way the act depends on. It is refused with nothing done, and the card re-renders naming who did what.
_Avoid_: conflict, optimistic lock, revision mismatch

**App shell**:
The shared frame for the portal, Company, Connections and Your machines: the header bar with sections, viewer and sign-out, over the page. Sign-in, create-or-join, device confirmation and error doors keep the card shell; portal not-found pages keep the app shell.
_Avoid_: layout, template, theme

**Component set**:
The built vocabulary of controls every first-party page composes: buttons, fields, fact lists, notices, headings, pills and confirmation forms, styled once in the shell so they look and scale the same everywhere. Page styles carry layout only; patches are exempt.
_Avoid_: design system (there is one theme and no library), component library, utility classes
