# Primitives

The resources a patch defines and owns, and the operations its admitted viewers use to work with them. Their cumulative existence belongs to the [company database's inventory](../company-database/CONTEXT.md); [Runtime](../runtime/CONTEXT.md) binds access to the loaded version and effective principal. Tier 1 operations act as the viewer. Tier 2 own-resource callbacks act as the patch; shared-resource callbacks require the initiating viewer's live authority.

## Language

**Definition**:
The specification of a resource a patch owns, including a required description of what its rows or files represent. A version's manifest says which definitions that version uses. Publishing a definition replaces its description; omitting one preserves the resource, description and data.
_Avoid_: declaration (a connection, shared table or shared file store the patch uses but does not own), inventory (the cumulative authority)

**Table**:
A patch-owned collection of rows with defined columns and indexes. An admitted company viewer reads and writes the owning patch's tables; a public version grants no table access.
_Avoid_: collection, relation (an integration's source object)

**Additive change**:
A compatible extension of cumulative definitions that preserves existing rows and older versions' contracts. Omission leaves compatible definitions unused rather than deleting them.
_Avoid_: migration (destructive changes are not offered), replacement, synchronization

**Schema revision**:
The patch's cumulative schema revision, advanced when provisioning changes its owned schema or table/store-sharing state. It is independent of published versions, runtime wire versions and description changes.
_Avoid_: version number, release

**Resource revision**:
The durable count of changes to one table or file store, including its writes and sharing changes. A subscription reads rows and their resource revision together; a shared read also depends on the source patch's lifecycle revision.
_Avoid_: schema revision, published version

**System column**:
A row's Patchy-maintained identity or creation/update timestamp: `id`, `createdAt` and `updatedAt`. Patch code reads them but cannot supply or change them.
_Avoid_: user column, metadata field

**Ref**:
A column identifying a row in a named table, without requiring that row to exist. A deleted or missing target is a dangling ref, read as a missing row rather than a cascading change.
_Avoid_: foreign key, join, embedded row

**Shared table**:
A source patch's table that another patch may declare and read, never write, while the source remains openable and the table shared. Its identity is the source patch and table; its sharing authority and cumulative definition belong to [Company database's Inventory](../company-database/CONTEXT.md), independent of the source's active version.
_Avoid_: public table, copied table

**File store**:
A named, patch-owned home for files shared by admitted company viewers. Its files persist independently of published versions; omitting the store leaves them intact and older versions that define it retain access.
_Avoid_: bucket, content store (the infrastructure holding bytes)

**Shared file store**:
A source patch's file store published as read-only access to every file for consumers on either tier, with the viewer's source access and the store's sharing rechecked on every read. Its immutable identity is the source patch and store; its sharing authority belongs to [Company database's Inventory](../company-database/CONTEXT.md), independent of published versions, omissions and rollbacks.
_Avoid_: public files, copied store, shared folder
