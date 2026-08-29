# Patches

What the instance holds and how long it holds it. `packages/patches` owns the patch and version records, the upload contract, visits and the retention clock, pins, moderation, the patch quota, the expiry sweep, the `patches` / `patch_versions` migration (id 3), and the `patches` group of the wire contract — `/api/uploads`, `/api/patches/:id` and its `disable`, `pin`, `unpin` and delete, `/api/principals/:id/patches`. It is the one place a patch's bytes are touched, through [Content store](../content-store/CONTEXT.md); it reports `patch.*` events through [Analytics](../analytics/CONTEXT.md) and spends the per-token create limit through [Limits](../limits/CONTEXT.md). Who is calling is never its question: every handler receives the principal from the bearer middleware [Auth](../auth/CONTEXT.md) implements, and this package never imports that one.

## Language

**Patch**:
The runtime-agnostic record of one published thing: an id, an owning principal, a title, its versions and the one that serves, a retention clock, a pin, and the stamps that take it out of service. Today every patch is a tier 0 static page; nothing in the record says so. The public URL is `/d/<id>`, which is contract and does not change with the rename.
_Avoid_: draft (the old name, gone from tables, code and the wire), page (what a patch is served as, not what it is), document (the HTML a version holds)

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
The consequence of the clock running out: the patch stops serving and refuses updates at that instant, and the sweep removes it for good later. Expiry is a hard delete — content and record both gone, no recovery, republishing is the way back — and applies to every patch whoever owns it, unless the patch is pinned.
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
