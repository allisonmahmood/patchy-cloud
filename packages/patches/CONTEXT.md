# Patches

What the company holds and how it is published: patches and versions, user ownership, sharing, visits, owner quotas and the lifecycle. Product decisions live in [the product](../../docs/product.md#patches).

## Language

**Patch**:
A built unit in a company's cloud, owned by one user and published as immutable versions. Shared with the company by default or made public on purpose; served as a tier 0 static page or tier 1 browser tool.
_Avoid_: draft, page (how a patch is served, not what it is), app (one possible patch), document (the HTML a version holds)

**Name**:
The human-readable label unique within a company's patch namespace, forming the patch's address rather than its identity. Retire and delete reserve its names until reclamation; renaming keeps the former name as a redirect until another patch takes it.
_Avoid_: id (the stable identity), title (the document's display text), slug

**Tier**:
Where a patch's code runs, not who may open it or what pricing plan it uses. Tier 0 is static; tier 1 runs in the reader's browser. Higher-runtime vocabulary is recorded in [the product](../../docs/product.md#runtime-tiers).
_Avoid_: runtime (the thing a tier names), level, plan (tiers are capability, not pricing)

**Owner**:
The one user in a company a patch belongs to, and the only one who publishes to it. Any machine token acting as that user can manage the patch; an admin may manage any company patch in the portal or reassign it to an active company member, but cannot publish without becoming its owner.
_Avoid_: creator (a version has a creating machine; ownership belongs to the user), editor, author

**Reassignment**:
An admin changing a patch's owner to an active member of the same company, including themselves. The patch keeps its identity and every version's publisher attribution.
_Avoid_: transfer (a patch never moves companies), republish, claim

**Sharing scope**:
Who may open a patch: `company` means signed-in colleagues in its company; `public` means anyone with the link to its current version, without signing in. Older versions stay behind the company door; new patches default to company sharing, and the owner or an admin may change a live patch's scope without publishing.
_Avoid_: visibility, token scope (a publishing key does not grant reading access)

**Openable patch**:
A patch in the credential's company, within its sharing reach and neither disabled nor gone, eligible for discovery and inventory reads in any lifecycle state. Today every company member has that reach; openability grants neither ownership nor permission to serve an off patch.
_Avoid_: serving (requires live), publishable (requires the live patch's owner), manageable (owner or admin)

**Patch repo**:
The local working copy for one patch: its source tree, definitions, declarations, explicit tier and target instance. Once published, its identity ties later publishes to that same patch.
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
Taking a live patch off its address indefinitely with everything kept, restorable by its owner or an admin.
_Avoid_: unpublish, archive, disable (the operator's take-down), deactivate (a user's state)

**Delete**:
Taking a live or retired patch off for a fixed recovery window, with its address and contents kept until the deletion sweep reclaims them. The owner or an admin may restore it before that window ends.
_Avoid_: destroy, purge, retire (the shelf, with no clock)

**Restore**:
Bringing a retired or deleted patch back live at its reserved address, by its owner or an admin, warning when its current version's shared sources are off.
_Avoid_: undelete, republish (restore makes no version)

**Recovery window**:
The 30 days after a delete during which the patch can be restored; when it runs out the deletion sweep reclaims the patch, its versions, resources and names.
_Avoid_: grace period, trash (the state, not the clock)

**Rollback**:
Moving a live patch's current version to any retained version, without creating a version or changing its data, provisioning, sharing, description or name.
_Avoid_: revert, redeploy, undo

**Dependant**:
A live, enabled patch that declares one of this patch's shared tables in any retained version, even when its current version dropped that declaration. Lifecycle warnings identify distinct dependant patches and their owners; discovery also associates each openable dependant with the tables it reads.
_Avoid_: consumer (a runtime word), subscriber

**Description**:
One paragraph saying what a patch does, written by the building agent and editable by its owner or an admin. It is local-owned with [description sync](../patchy/CONTEXT.md): publish sends the repo's text, and newer cloud edits pull back into the repo with a notice.
_Avoid_: purpose (the agent instruction, kept separately), title (the document's `<title>`), summary

**Version**:
One immutable publication of a patch: its bundle, manifest, release and contract versions, the machine token that published it and where it came from. Numbered from 1 per patch; revocation does not erase provenance, and changing sharing does not change the content a version URL names.
_Avoid_: revision, upload (the act, not the record)

**Publish contract**:
The promise that a successful publish leaves both a version and its content, while a refused publish leaves no version and content from failed or refused attempts is durably queued for reclamation. An uncertain outcome preserves committed content while unreferenced bytes are eventually reclaimed; retrying the same attempt returns its original result, even when the instance's current release has changed.
_Avoid_: two-phase commit, saga

**Manifest**:
The serializable description of one version's name, release, tier, owned tables and file stores, and declared connections and shared tables. It describes the patch's contract rather than executing its source.
_Avoid_: config (the source from which a manifest is produced), inventory (the cumulative provisioned definitions)

**Inventory**:
The cumulative provisioned definitions, company-readable through the openable gate rather than ownership and preserved when a current version omits them. Unavailable inventory is unknown, not empty; see **Inventory** in [Company database](../company-database/CONTEXT.md), its owning glossary.
_Avoid_: manifest, current schema

**Unused definition**:
A provisioned definition omitted from one version's manifest without removing its resource or data. Older versions that still define it retain access.
_Avoid_: dropped resource, deleted definition

**Publish key**:
The owner-scoped identity of one publish attempt. Resending its unchanged payload recovers the original result; a changed payload under the same key is a conflict, not another version.
_Avoid_: patch id, machine token, version id

**Bundle**:
The self-contained HTML content of one version, paired with its manifest. A tier 0 bundle obeys the safe-HTML policy; a tier 1 bundle retains its scripts and runs only inside the sandbox.
_Avoid_: source tree, manifest, patch (the entity that holds versions)

**Deletion sweep**:
The reclamation of deleted patches past their recovery window, including their versions, resources and names, and unreferenced content left by failed publishes. Content awaiting removal stays durably queued until removal succeeds.
_Avoid_: cleanup job, garbage collection, reaper, purge

**Visit**:
One successful serving of a patch from the instance, at its latest or a version URL. Recording its count is best-effort and never costs the reader the page if it fails; it is never an analytics event.
_Avoid_: view, hit, page load (a visit is a serving that succeeded, not a request that arrived)

**Live patch**:
A patch that has been neither retired nor deleted. A separate operator take-down can prevent it serving without changing its lifecycle state.
_Avoid_: active patch, published patch (every patch is published)

**Patch quota**:
The ceiling on non-deleted, non-disabled patches one owner user may hold, surviving a restart and a replacement machine token. Retired patches still count; it is separate from the per-machine rate limit on creating patches.
_Avoid_: patch limit (the per-minute one), storage quota (this counts patches, not bytes)

**Patch event**:
A committed publish, update or owner deletion, attributed to the user who acted; reclamation belongs to the instance. Events contain ids, sizes, counts and states, never content, a filename, a URL or an address.
_Avoid_: audit log, activity feed
