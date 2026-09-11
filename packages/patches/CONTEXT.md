# Patches

What the company holds and how it is published: patches and versions, user ownership, sharing, visits, retention and owner quotas. The vocabulary also names patch repos, tiers, primitives and future retirement; their product decisions live in [the product](../../docs/product.md#patches).

## Language

**Patch**:
A built unit in a company's cloud, owned by one user and published as immutable versions. Shared with the company by default or made public on purpose; served as a tier 0 static page or tier 1 browser tool.
_Avoid_: draft, page (how a patch is served, not what it is), app (one possible patch), document (the HTML a version holds)

**Name**:
The human-readable label unique within a company's patch namespace, forming the patch's address rather than its identity. Renaming keeps the former name as a redirect until another patch takes it; deleting the patch frees its names.
_Avoid_: id (the stable identity), title (the document's display text), slug

**Tier**:
Where a patch's code runs, not who may open it or what pricing plan it uses. Tier 0 is static; tier 1 runs in the reader's browser. Higher-runtime vocabulary is recorded in [the product](../../docs/product.md#runtime-tiers).
_Avoid_: runtime (the thing a tier names), level, plan (tiers are capability, not pricing)

**Owner**:
The one user in a company a patch belongs to, and the only one who changes it. Any machine token acting as that user can publish a version, change its sharing scope or delete the patch; changing the key never changes ownership.
_Avoid_: creator (a version has a creating machine; ownership belongs to the user), editor, author

**Sharing scope**:
Who may open a patch: `company` means signed-in colleagues in its company; `public` means anyone with the link to its current version, without signing in. Only the current version of a public patch is public; older versions stay behind the company door. A new patch is shared with the company by default, and only its owner can change the scope in either direction; republishing preserves it unless the owner explicitly chooses another scope.
_Avoid_: visibility, token scope (a publishing key does not grant reading access)

**Patch repo**:
The local working copy of exactly one patch: its file tree, id, declared tier and base config. Its creation and publishing rules live in [the product](../../docs/product.md#what-a-patch-is-made-of).
_Avoid_: project, workspace, source (a repo holds the source; it is also the unit)

**Publish**:
The act that puts a patch up: a new version, live at once to everyone the patch is shared with. There is no unpublished patch or working copy in the cloud.
_Avoid_: deploy, upload (moving bytes, not publishing), release, promote

**Primitive**:
A capability the cloud provides because a patch declared the need, belonging either to that patch or to its company. Patch-owned tables and file stores are defined in the manifest and provisioned additively at publish; their language belongs to [Primitives](../primitives/CONTEXT.md).
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
One immutable publication of a patch: its bundle, manifest, release and contract versions, the machine token that published it and where it came from. Numbered from 1 per patch; revocation does not erase provenance, and changing sharing does not change the content a version URL names.
_Avoid_: revision, upload (the act, not the record)

**Publish contract**:
The promise that a successful publish leaves both a version and its content, while a refused publish leaves no version and content from failed or refused attempts is durably queued for reclamation. An uncertain outcome preserves committed content while unreferenced bytes are eventually reclaimed; retrying the same attempt returns its original result, even when the instance's current release has changed.
_Avoid_: two-phase commit, saga

**Manifest**:
The serializable description of one version's release, tier, owned tables and file stores, and declared connections and shared tables. It describes the patch's contract rather than executing its source.
_Avoid_: config (the source from which a manifest is produced), inventory (the cumulative provisioned definitions)

**Inventory**:
The cumulative resources provisioned for a patch, including definitions omitted by its current version. It is the company database's authority, not a reconstruction of the active manifest; see [Company database](../company-database/CONTEXT.md).
_Avoid_: manifest, current schema

**Unused definition**:
A cumulative definition that a published version no longer uses. Its resource and data remain, and older versions that still define it keep reaching it.
_Avoid_: dropped resource, deleted definition

**Publish key**:
The owner-scoped identity of one publish attempt. Resending its unchanged payload recovers the original result; a changed payload under the same key is a conflict, not another version.
_Avoid_: patch id, machine token, version id

**Bundle**:
The self-contained HTML content of one version, paired with its manifest. A tier 0 bundle obeys the safe-HTML policy; a tier 1 bundle retains its scripts and runs only inside the sandbox.
_Avoid_: source tree, manifest, patch (the entity that holds versions)

**Retention clock**:
The expiry anchor every patch carries: a publish resets it to 90 days out, and a visit with less than 30 days left moves it to 30 days out, never shorter or back from expiry. Revoking a machine token does not change this clock.
_Avoid_: TTL, lease

**Patch expiry**:
The consequence of the retention clock running out: the patch stops serving and refuses updates, then the sweep removes its content and record with no recovery. The decision to remove expiry is recorded in [the product](../../docs/product.md#updating-retiring-deleting).
_Avoid_: soft delete, archival, retention (that is the clock; expiry is the consequence)

**Expiry sweep**:
The removal of expired patches, their versions and stored content, together with unreferenced content left by failed or refused publishes, ending that storage cost and expired patches' contribution to the owner's quota. Content awaiting removal stays durably queued until removal succeeds.
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
