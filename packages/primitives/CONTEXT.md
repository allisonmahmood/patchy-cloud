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
A compatible extension of the cumulative definitions that preserves existing rows and the contracts of older versions. A refused change names the object, the incompatible change and the fix; omitted compatible definitions remain as unused resources.
_Avoid_: migration (destructive changes are not offered), replacement, synchronization

**Schema revision**:
The patch's cumulative definition revision, advanced only when provisioning changes its tables. It is independent of a published version and the runtime wire version.
_Avoid_: version number, release

**System column**:
A row's Patchy-maintained identity or creation/update timestamp: `id`, `createdAt` and `updatedAt`. Patch code reads them but cannot supply or change them.
_Avoid_: user column, metadata field

**Ref**:
A column identifying a row in a named table, without requiring that row to exist. A deleted or missing target is a dangling ref, read as a missing row rather than a cascading change.
_Avoid_: foreign key, join, embedded row

**Shared table**:
A source patch's table made available for other patches to declare and read, never write. Sharing authority belongs to the cumulative inventory; cross-patch declarations and reads arrive with [#200](https://github.com/allisonmahmood/patchy-cloud/issues/200).
_Avoid_: public table, copied table

**File store**:
A named, patch-owned home for files. File operations and provisioning arrive with [#199](https://github.com/allisonmahmood/patchy-cloud/issues/199).
_Avoid_: bucket, content store (the infrastructure holding bytes)
