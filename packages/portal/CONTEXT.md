# Portal

Where a signed-in person finds and manages their company's patches: the landing at `/`, one patch's card, its management acts, and the deactivation and reactivation choices about a user's patches. The patch, its states and its owner belong to [Patches](../patches/CONTEXT.md); the viewer to [Auth](../auth/CONTEXT.md); users and roles to [Companies](../companies/CONTEXT.md). Decided on [the portal map](https://github.com/allisonmahmood/patchy-cloud/issues/230) and specified in [#247](https://github.com/allisonmahmood/patchy-cloud/issues/247); the package does not exist yet.

## Language

**Portal**:
The signed-in landing at `/`: the company's patches on one side and one patch's card on the other. It lists only the viewer's own company, public patches included, and never another company's.
_Avoid_: dashboard, home page (the signed-out marketing page), directory (the index is one half of it)

**Index**:
The compact list of the company's patches beside the card: name and the first clause of the description, grouped as the viewer's own, the company's, and retired and deleted behind a toggle.
_Avoid_: sidebar, list (the CLI's `patchy list` is discovery, not this), table

**Card**:
One patch's page at `/patches/<name>`: its address, description, owner, current version, who can open it and what reads it, with the management acts for whoever may perform them. The card is catalog plus manage, never the patch itself, which lives at its address.
_Avoid_: patch page (the patch is the page at the address), detail view, dossier

**Manage**:
The acts an owner or admin performs from the card: describe, change who can open it, show another version at the address, restore, retire, delete and reassign. An act stays on the card when the same actor can undo it with one click; otherwise it leaves for a confirmation page.
_Avoid_: settings, admin panel, edit mode

**Confirmation page**:
A page under the card's URL holding one act that breaks someone else's tool or that the actor cannot undo alone: the consequence in plain words, what breaks, the acknowledgement, and the way back to the card.
_Avoid_: modal, dialog, are-you-sure

**Acknowledgement**:
The actor's explicit acceptance, on a confirmation page, of the breakage an act causes to listed dependants; absent when nothing breaks. In the CLI its counterpart is `--force`.
_Avoid_: consent, override, warning (what precedes it)

**Pick page**:
The deactivation or reactivation step that lists a user's patches with what each depends on, for the admin to leave alone, act on a selection, or act on all, before a confirmation recomputed for that selection.
_Avoid_: bulk action, checklist, wizard

**Stale action**:
An act posted from a page whose patch has since changed in the way the act depends on. It is refused with nothing done, and the card re-renders naming who did what.
_Avoid_: conflict, optimistic lock, revision mismatch

**App shell**:
The frame every page a signed-in member reaches renders through: the header bar with the sections, the viewer and sign-out, over the page. Doors (sign-in, create-or-join, device confirmation, errors) keep the card shell instead.
_Avoid_: layout, template, theme

**Component set**:
The one vocabulary of controls every first-party page composes: buttons, fields, fact lists, notices, headings and pills, styled once in the shell so they look and scale the same everywhere. Page styles carry layout only; patches are exempt.
_Avoid_: design system (there is one theme and no library), component library, utility classes
