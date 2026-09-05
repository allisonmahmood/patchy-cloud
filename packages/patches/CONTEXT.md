# Patches

What the instance holds and how long it holds it. `packages/patches` owns patches and versions, publishing, visits and retention, owner quotas, expiry and the `patches` API group; it stores content through [Content store](../content-store/CONTEXT.md) and reports business events through [Analytics](../analytics/CONTEXT.md). Handlers receive the user and machine identity from bearer middleware without importing Auth.

## Language

**Patch**:
A built unit in a company's cloud: one thing, stored, permissioned and provisioned as one, at one address, running at one tier. Made by a person or their agent, published as immutable versions, live to the whole company from the moment it is published, and never expiring on its own. Today every patch is a tier 0 static page; nothing in the record says so.
_Avoid_: draft (the old name, retired everywhere — see [Publishing](../cli/CONTEXT.md)), page (what a tier 0 patch is served as, not what it is), app (a tier 2 patch is one; the word says nothing about the rest), document (the HTML a version holds)

**Tier**:
Where a patch's code runs, and nothing else: tier 0 _static_ (no code runs anywhere), tier 1 _browser_ (code runs in the [viewer](../serving/CONTEXT.md)'s browser, as the viewer), tier 2 _hosted_ (server-side code too, run by the cloud only while a viewer has the patch open); tier 3 (work with no viewer present) and tier 4 (an agent's own computer) are named and not designed. Declared as an explicit field in the patch repo, checked against the tree on every publish — a tree that says more than its declared tier is refused. A version has exactly one tier and the patch's tier is its served version's; changing tier is publishing a version built for the new tier, never a move in place. A tier never changes who may open a patch, what it may declare, or how it is published, shared or found.
_Avoid_: runtime (the thing a tier names), level, plan (tiers are capability, not pricing)

**Owner**:
The one user in a company a patch belongs to, and the only one who changes it. Any machine token acting as that user can publish a version or delete the patch; changing the key never changes ownership.
_Avoid_: creator (the first version's token; the owner can change), editor, author

**Patch repo**:
The folder a patch is built in — the file tree that is the patch, plus its id, declared tier and base config. Created by the CLI (`init`) or linked to an existing patch; one repo is the working copy of exactly one patch, and the first publish from a repo with no id creates the patch and writes it back. Today's single HTML file is a one-file tree without a repo.
_Avoid_: project, workspace, source (a repo holds the source; it is also the unit)

**Publish**:
The act that puts a patch up: a new version, live at once to everyone the patch is shared with. There is no unpublished patch and no working copy in the cloud — the working copy is the repo.
_Avoid_: deploy, upload (the wire route, not the act), release, promote

**Primitive**:
A capability the cloud provides a patch because it declared the need, in one of two scopes: patch-scoped — the patch's own tables, its file storage — provisioned with the patch, part of it, gone with it; company-scoped — a connection ([Integrations](../integrations/CONTEXT.md)), the company database — existing once for the whole company, used by patches and owned by none. A patch's tables are patch-scoped wherever they physically live.
_Avoid_: resource, service, addon

**Extension**:
A patch that plugs into another patch. Reserved for the long run: promised, not defined, and nothing today composes patches beyond linking by address.
_Avoid_: plugin, module

**Retire**:
The owner taking a patch off its address while keeping it — restorable, and still the owner's. Once companies land, deactivating a patch's owner is another road into the same kept-but-off state.
_Avoid_: unpublish, archive, disable

**Delete**:
The owner removing a patch for good, after a recovery window. The one exit that frees a patch's bytes.
_Avoid_: destroy, purge

**Version**:
One upload of a patch: its immutable content, the machine token that published it, and where it came from. Numbered from 1 per patch; the token remains as provenance even after revocation, and a version URL (`/d/<id>/v/<n>`) names content that never changes.
_Avoid_: revision, upload (the act, not the record)

**Upload contract**:
How a version lands: check the target, put its content, then record the version; a refused record removes the content again. Missing, another user's, deleted, disabled and expired targets all answer the same 404, while a create colliding with an existing id answers 409; an uncertain commit keeps the content rather than risk losing a committed page.
_Avoid_: two-phase commit, saga

**Retention clock**:
The one anchor every patch carries, `expiresAt`, and the rules that move it: an upload resets it to the full retention window (90 days); a visit with less than the visit-extension window (30 days) remaining moves it to exactly that window out — never shorter, never reviving an expired patch. Revoking a machine token does not change this clock.
_Avoid_: TTL, lease

**Patch expiry**:
The consequence of the clock running out: the patch stops serving and refuses updates at that instant, and the sweep removes it for good later. Expiry is a hard delete — content and record both gone, no recovery, republishing is the way back — and applies to every patch whoever owns it. Inherited from public hosting and decided out ([What a patch is](https://github.com/allisonmahmood/patchy-cloud/issues/16)): a patch in a company's cloud never expires; the clock and the sweep leave in the [expiry-removal effort](https://github.com/allisonmahmood/patchy-cloud/issues/93).
_Avoid_: soft delete, archival, retention (that is the clock; expiry is the consequence)

**Expiry sweep**:
The job that removes expired patches and versions before their stored content, reporting failures and orphaned objects. An idempotent sweep ends their storage cost and their contribution to the owner user's quota.
_Avoid_: cleanup job, garbage collection, reaper, purge

**Visit**:
One successful serving of a patch, at its latest or a version URL. The only thing besides an upload that moves a retention clock, and only ever forward; recorded best-effort, after the page is already in hand, because losing a top-up costs some retention and a failed write must not cost the reader the page. Never reported to analytics.
_Avoid_: view, hit, page load (a visit is a serving that succeeded, not a request that arrived)

**Live patch**:
A patch still counting against its owner's quota: neither deleted nor disabled. It leaves the tally the moment it is deleted or disabled, and for good when the sweep takes it — an expired patch still counts until then, because its row and bytes are still there.
_Avoid_: active patch, published patch (every patch is published)

**Patch quota**:
The ceiling on live patches one owner user may hold, counted from the database on every create so it survives a restart and a replacement machine token. The per-machine per-minute create limit is spent first; the owner quota is refused as 403 `live_patch_quota_exceeded` with the ceiling.
_Avoid_: patch limit (the per-minute one), storage quota (this counts patches, not bytes)

**Patch event**:
A committed publish, update or owner deletion, attributed to the user who acted; expiry is attributed to the instance. Events contain ids, sizes, counts and states — never content, a filename, a URL or an address.
_Avoid_: audit log, activity feed
