# Primitives

The resources a patch defines and owns, and the operations its admitted viewers use to work with them. Their cumulative existence belongs to the [company database's inventory](../company-database/CONTEXT.md); access is bound by [Runtime](../runtime/CONTEXT.md) to the loaded version and acting identity.

## Language

**Definition**:
The description of a resource a patch owns. A version's manifest says which definitions that version uses; omitting a definition does not erase the resource or its data.
_Avoid_: declaration (a connection or shared table the patch uses but does not own), inventory (the cumulative authority)

**Table**:
A patch-owned collection of rows with defined columns and indexes. An admitted company viewer reads and writes the owning patch's tables; a public version grants no table access.
_Avoid_: collection, relation (an integration's source object)

**Additive change**:
A compatible extension of cumulative definitions that preserves existing rows and older versions' contracts. Omission leaves compatible definitions unused rather than deleting them.
_Avoid_: migration (destructive changes are not offered), replacement, synchronization

**Schema revision**:
The patch's cumulative definition revision, advanced when provisioning changes its owned resources or table-sharing state. It is independent of a published version and the runtime wire version.
_Avoid_: version number, release

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
