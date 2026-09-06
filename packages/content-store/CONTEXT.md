# Content store

Where a patch's published bytes live, separate from its metadata. [Patches](../patches/CONTEXT.md) owns the content's association with a version and its lifetime; the content store owns neither.

## Language

**Content store**:
The platform's object store for a patch's published content, one HTML object per version. It distinguishes an invalid object key, absent content and an unavailable store.
_Avoid_: storage (reserved for the later per-patch file primitive), blob store (one of the two layers, not the service), bucket

**Object key**:
The name under which a version's content is held, recorded with that version. It identifies content inside the store, never a location outside its boundary.
_Avoid_: file path, blob name (what the Azure layer calls it underneath)
