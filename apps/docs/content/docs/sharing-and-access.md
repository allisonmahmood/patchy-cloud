---
title: Sharing and access
description: Who can open a patch, how its owner changes that, and what members, admins and guests can each do.
---

## Who can open a patch

A patch's **audience** says who can open it. There are three:

- **Company**: everyone at the patch's company. A first publish uses it unless told otherwise.
- **Teams**: the people on one or more of the company's teams, up to 100 teams.
- **Public**: anyone with the link, signed in or not. Only a tier 1 page can be public, only its current version is public, and a public page reaches no data: its tables, files and `me()` are unavailable even to members.

The audience must include the patch's owner. On top of it, the owner can share a patch with **guests**, named people at other companies.

Patchy checks access on every request. Someone removed from the audience, or from a team the audience names, loses the patch on their next request, and any page of it they have open stops.

## Choosing the audience

The owner sets it when publishing, or changes it without publishing:

```sh
patchy publish plan.html --share public
patchy publish plan.html --share teams --team design --team sales
patchy share plan.html company
```

`patchy audiences` lists the company's teams. A publish without `--share` keeps the audience the patch already has. In a patch repo, `pnpm patchy publish --share …` and `pnpm patchy share …` act on the repo's patch.

In the portal, **Share** on a patch opens the Share dialog, where the owner or an admin changes who can open it, invites guests and copies the link. Making a page public asks first, since anyone with the link can then open it without signing in.

## Opening a link

| Who opens the address                       | What they get                                     |
| ------------------------------------------- | ------------------------------------------------- |
| A colleague in the audience                 | The patch                                         |
| Someone signed out                          | The sign-in page, which returns them to the patch |
| A colleague outside a team patch's audience | The same "not found" as a missing address         |
| A member of another company, not a guest    | The same "not found" as a missing address         |
| A deactivated user                          | A page saying their account is deactivated        |

A missing patch and one the reader can't open look the same, so a link confirms nothing to someone outside it. There is no request-access button.

## Guests

A **guest** is someone at another company who already has a Patchy account, given one patch. They open it as themselves, inside the patch's company but never as its admin, and the grant gives them no membership and no other patch. They find it under **Shared with you** on their Home.

```sh
patchy share plan.html --add jo@pine.example
patchy share plan.html --list
patchy share plan.html --remove jo@pine.example
```

Sharing takes effect at once and Patchy sends no email, so the sharer passes on the link. Sharing refuses an email with no active Patchy account, and someone already in the company.

- On tier 1, a guest reads and writes the patch's own tables and files as a colleague does. A patch whose guests must not write everything is tier 2.
- On tier 2, a guest can start only the handlers marked `guest: true`.
- A patch is closed to its guests while its current version reads another patch's shared table or store, or uses a connection an admin set to block guests. Their grants stay, and they are back once that changes.

People › Guests in the portal lists every guest the company has and what each holds; an admin can remove someone from all the company's patches at once.

## Roles

A company has two roles:

- **Members** build and publish patches with no gate.
- **Admins** also invite people, change roles, deactivate and reactivate users, manage teams, connect integrations, change the company's look and turn agent access on or off. A company always keeps at least one active admin.

A patch's **owner** publishes it, changes its audience and guests, describes it, rolls it back, and retires, deletes or restores it. An admin can manage every patch in the company from the portal, including reassigning it to another active member, but opening its content, its description and versions included, still takes being in its audience. Publishing stays the owner's.

## Teams

A **team** is a named set of people in the company; a person can be on several. Admins create, rename and delete teams and change who is on them; members see every team and who is on it. A change to a team takes effect on the next request. A team can be deleted only once no patch or connection names it.

## When someone leaves

**Deactivating** a user ends their access on their next request, revokes every publishing key and agent connection they hold, and keeps all their data. Their patches keep serving their audiences unless an admin retires them, and nobody can publish to them until the owner is reactivated or an admin reassigns them. Reactivation restores sign-in to the same company and data; the computers and agents have to be connected again.

## Finding patches

**Home**, at the portal's root, shows the patches a person uses most, colleagues' new patches and the person's own. **All patches** lists every patch they can open, with a search across names, titles, descriptions and owners. Mod+Shift+K (⌘⇧K on a Mac) opens **Go to…**, a quick switcher, from any portal page or company patch.

Agents find patches with `patchy list`, which shows only the patches the computer's user can open.
