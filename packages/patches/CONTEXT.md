# Patches

What the instance holds and how long it holds it. `packages/patches` owns the patch and version records, the upload contract, visits and the retention clock, pins, moderation, the patch quota, the expiry sweep, the `patches` / `patch_versions` migration (id 3), and the `patches` group of the wire contract — `/api/uploads`, `/api/patches/:id` and its `disable`, `pin`, `unpin` and delete, `/api/principals/:id/patches`. It is the one place a patch's bytes are touched, through [Content store](../content-store/CONTEXT.md); it reports `patch.*` events through [Analytics](../analytics/CONTEXT.md) and spends the per-token create limit through [Limits](../limits/CONTEXT.md). Who is calling is never its question: every handler receives the principal from the bearer middleware [Auth](../auth/CONTEXT.md) implements, and this package never imports that one.

## Language

**Patch**:
A built unit in a company's cloud: one thing, stored, permissioned and provisioned as one, at one address, running at one tier. Made by a person or their agent, published as immutable versions, live to the whole company from the moment it is published, and never expiring on its own. Today every patch is a tier 0 static page; nothing in the record says so.
_Avoid_: draft (the old name, retired everywhere — see [Publishing](../cli/CONTEXT.md)), page (what a tier 0 patch is served as, not what it is), app (a tier 2 patch is one; the word says nothing about the rest), document (the HTML a version holds)

**Tier**:
The runtime a patch runs at, exactly one per patch, declared in its patch repo: tier 0 static (no code runs anywhere), tier 1 in the browser as the viewer, tier 2 with its own server side, tier 3 with work that runs without a viewer. The tree's structure implies a tier too, and a publish whose tree says more than the declared tier is refused.
_Avoid_: runtime (the thing a tier names), level, plan (tiers are capability, not pricing)

**Patch repo**:
The folder a patch is built in — the file tree that is the patch, plus its id, declared tier and base config. Created by the CLI (`init`) or linked to an existing patch; one repo is the working copy of exactly one patch, and the first publish from a repo with no id creates the patch and writes it back. Today's single HTML file is a one-file tree without a repo.
_Avoid_: project, workspace, source (a repo holds the source; it is also the unit)

**Publish**:
The act that puts a patch up: a new version, live at once to everyone the patch is shared with. There is no unpublished patch and no working copy in the cloud — the working copy is the repo.
_Avoid_: deploy, upload (the wire route, not the act), release, promote

**Primitive**:
A capability the cloud provisions a patch with because it says it needs one — file storage, its own tables, a company integration. Provisioned per patch, as part of the patch, never shared out of it.
_Avoid_: resource, service, addon

**Extension**:
A patch that plugs into another patch. Reserved for the long run: promised, not defined, and nothing today composes patches beyond linking by address.
_Avoid_: plugin, module

**Retire**:
The owner taking a patch off its address while keeping it — restorable, and still the owner's. Today the same state as `disable`, reached by moderation; the owner's act and the operator's act share the state and differ in who took it.
_Avoid_: unpublish, archive, disable (the moderation act)

**Delete**:
The owner or operator removing a patch for good, after a recovery window. The one exit that frees a patch's bytes.
_Avoid_: destroy, purge

**Version**:
One upload of a patch: the object key its bytes sit under, their hash and size, the token that made it, and where it came from. Numbered from 1 per patch; the first version's token is the patch's creator for good, whatever token uploads later. A version URL (`/d/<id>/v/<n>`) names content that never changes.
_Avoid_: revision, upload (the act, not the record)

**Upload contract**:
How a version lands: the target is checked, the object is put, the row is inserted — and on a refused row the object is deleted again. The object goes first so the metadata lock is never held while the store is slow and a refusal leaves nothing behind; a row failure that is not a refusal keeps its object, because the commit may have happened and an orphan costs storage where a vanished object costs the reader the page. The two refusals are one 404 (`Patch not found.` — unknown, another principal's, deleted, disabled or expired, never saying which) and one 409 (`Patch already exists.`).
_Avoid_: two-phase commit, saga

**Retention clock**:
The one anchor every patch carries, `expiresAt`, and the rules that move it: an upload resets it to the full retention window (90 days); a visit with less than the visit-extension window (30 days) remaining moves it to exactly that window out — never shorter, never reviving an expired patch; the check is `expiresAt < now` and nothing else; a pinned patch is never expired. Read on the Effect clock, so a test winds it. Revoking a patch's creating token freezes its top-ups: from then on the clock only runs down.
_Avoid_: TTL, lease

**Patch expiry**:
The consequence of the clock running out: the patch stops serving and refuses updates at that instant, and the sweep removes it for good later. Expiry is a hard delete — content and record both gone, no recovery, republishing is the way back — and applies to every patch whoever owns it, unless the patch is pinned. Inherited from public hosting and decided out ([What a patch is](https://github.com/allisonmahmood/patchy-cloud/issues/16)): a patch in a company's cloud never expires; the clock, the sweep and pins leave with the build that lands ownership.
_Avoid_: soft delete, archival, retention (that is the clock; expiry is the consequence)

**Expiry sweep**:
The job that carries expiry out: one `sweep` that takes every patch whose clock has run out and no pin holds — the versions and the row, then the objects behind them — and answers with what it deleted, skipped, failed to delete, and left orphaned in the store. The record goes before the bytes on purpose. The server forks it on the Effect clock, once on the way up and then hourly; every run re-reads the database, so a run is idempotent, two overlapping runs are safe, and a patch pinned mid-run stays. It is the moment a patch stops costing storage and stops counting against its creator's quota.
_Avoid_: cleanup job, garbage collection, reaper, purge

**Visit**:
One successful serving of a patch, at its latest or a version URL. The only thing besides an upload that moves a retention clock, and only ever forward; recorded best-effort, after the page is already in hand, because losing a top-up costs some retention and a failed write must not cost the reader the page. Never reported to analytics.
_Avoid_: view, hit, page load (a visit is a serving that succeeded, not a request that arrived)

**Live patch**:
A patch still counting against its creator's quota: neither deleted nor disabled. It leaves the tally the moment it is deleted or disabled, and for good when the sweep takes it — an expired patch still counts until then, because its row and its bytes are still there.
_Avoid_: active patch, published patch (every patch is published)

**Patch quota**:
The ceiling on live patches one token may hold, counted from the database on every create so it survives a restart — unlike the per-minute create limit, which is in memory and spent first, so a caller parked at the quota is throttled rather than left to re-count the database. Per token, uniform, no exemption for admin tokens. Refused as 403 `live_patch_quota_exceeded` with the ceiling.
_Avoid_: patch limit (the per-minute one), storage quota (this counts patches, not bytes)

**Pinned patch**:
A patch an operator has exempted from expiry, for pages the instance itself maintains. Admin-only; otherwise ordinary — served, updatable by its owner, counted against its creator's quota. The clock keeps running underneath the pin and visits keep topping it up, so unpinning hands the patch back to whatever time it has left. A pin only ever holds a patch in service: deleting or disabling ends it, and a patch already off cannot be pinned — moderation and deletion outrank a pin, so neither can leave content the sweep may never take.
_Avoid_: permanent patch, system page

**Moderation**:
The operator's loop from a flagged URL to a resolved principal: the admin read answers for a patch that is disabled, deleted or expired too, with the principal behind it and the token that created it; the principal's list shows everything else it holds, newest first, deleted patches omitted so the list drains as it is worked; disable takes a patch out of service at once (its creator may, admin reaches any principal's); delete removes it from service and from the list, and the sweep frees its bytes. Revoking the token is [Auth](../auth/CONTEXT.md)'s last step.
_Avoid_: takedown (one step of it), ban (that is the token's revocation)

**Patch event**:
What this capability reports through Analytics: `patch.created` and `patch.updated` on a committed upload (with the version number and the stored size), `patch.disabled` and `patch.deleted` marking whether an admin acted, and `patch.expired` on no principal at all when the sweep takes a patch. Ids, sizes, counts and states — never content, a filename, a URL or an address.
_Avoid_: audit log, activity feed
