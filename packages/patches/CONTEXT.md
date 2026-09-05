# Patches

What the company holds and how it is published: patches and versions, user ownership, sharing, visits, retention and owner quotas. The vocabulary also names future patch repos, tiers, primitives and retirement; their product decisions live in [the product](../../docs/product.md#patches).

## Language

**Patch**:
A built unit in a company's cloud, owned by one user and published as immutable versions. Shared with the company by default or made public on purpose; the current runtime serves it as a tier 0 static page.
_Avoid_: draft, page (how a tier 0 patch is served, not what it is), app (one possible patch), document (the HTML a version holds)

**Tier**:
Where a patch's code runs, not who may open it or what pricing plan it uses. Tier 0 is static; the higher-runtime vocabulary and future declarations are recorded in [the product](../../docs/product.md#runtime-tiers).
_Avoid_: runtime (the thing a tier names), level, plan (tiers are capability, not pricing)

**Owner**:
The one user in a company a patch belongs to, and the only one who changes it. Any machine token acting as that user can publish a version, change its sharing scope or delete the patch; changing the key never changes ownership.
_Avoid_: creator (a version has a creating machine; ownership belongs to the user), editor, author

**Sharing scope**:
Who may open a patch: `company` means signed-in colleagues in its company; `public` means anyone with the link, without signing in. A new patch is shared with the company by default, and only its owner can change the scope in either direction; republishing preserves it unless the owner explicitly chooses another scope.
_Avoid_: visibility, token scope (a publishing key does not grant reading access)

**Patch repo**:
The future working copy of exactly one patch: its file tree, id, declared tier and base config. Its creation and publishing rules live in [the product](../../docs/product.md#what-a-patch-is-made-of).
_Avoid_: project, workspace, source (a repo holds the source; it is also the unit)

**Publish**:
The act that puts a patch up: a new version, live at once to everyone the patch is shared with. There is no unpublished patch or working copy in the cloud.
_Avoid_: deploy, upload (the wire route, not the act), release, promote

**Primitive**:
A capability the cloud provides because a patch declared the need, belonging either to that patch or to its company. The future provision and ownership rules live in [the product](../../docs/product.md#integrations).
_Avoid_: resource, service, addon

**Extension**:
A future patch that plugs into another patch. The composition model is not yet designed.
_Avoid_: plugin, module

**Retire**:
The future kept-but-off state of a patch, restorable by its owner. Its lifecycle is recorded in [the product](../../docs/product.md#updating-retiring-deleting).
_Avoid_: unpublish, archive, disable (the operator's take-down)

**Delete**:
The owner's removal of a patch from service, with no restore action. Stored content remains until its retention clock expires and the sweep removes it; the future recovery-window model lives in [the product](../../docs/product.md#updating-retiring-deleting).
_Avoid_: destroy, purge

**Version**:
One immutable publication of a patch: its content, the machine token that published it and where it came from. Numbered from 1 per patch; revocation does not erase provenance, and changing sharing does not change the content a version URL names.
_Avoid_: revision, upload (the act, not the record)

**Upload contract**:
The promise that a successful publish leaves both a version and its content, while a refused publish leaves neither. An uncertain outcome preserves content rather than risk losing a committed page.
_Avoid_: two-phase commit, saga

**Retention clock**:
The expiry anchor every patch carries: an upload resets it to 90 days out, and a visit with less than 30 days left moves it to 30 days out, never shorter or back from expiry. Revoking a machine token does not change this clock.
_Avoid_: TTL, lease

**Patch expiry**:
The consequence of the retention clock running out: the patch stops serving and refuses updates, then the sweep removes its content and record with no recovery. The decision to remove expiry is recorded in [the product](../../docs/product.md#updating-retiring-deleting).
_Avoid_: soft delete, archival, retention (that is the clock; expiry is the consequence)

**Expiry sweep**:
The removal of expired patches, their versions and stored content. It ends their storage cost and their contribution to the owner's quota.
_Avoid_: cleanup job, garbage collection, reaper, purge

**Visit**:
One successful serving of a patch from the instance, at its latest or a version URL. It extends retention best-effort, never costs the reader the page if recording fails, and is never an analytics event.
_Avoid_: view, hit, page load (a visit is a serving that succeeded, not a request that arrived)

**Live patch**:
A patch still counting against its owner's quota: neither deleted by its owner nor disabled through the operator's manual take-down. It leaves the tally the moment it is deleted or disabled, and for good when the sweep takes it — an expired patch still counts until then, because its row and bytes are still there.
_Avoid_: active patch, published patch (every patch is published)

**Patch quota**:
The ceiling on live patches one owner user may hold, surviving a restart and a replacement machine token. It is separate from the per-machine rate limit on creating patches.
_Avoid_: patch limit (the per-minute one), storage quota (this counts patches, not bytes)

**Patch event**:
A committed publish, update or owner deletion, attributed to the user who acted; expiry is attributed to the instance. Events contain ids, sizes, counts and states — never content, a filename, a URL or an address.
_Avoid_: audit log, activity feed
