# Content store

Where a patch's bytes live, separate from their metadata. [Patches](../patches/CONTEXT.md) owns published versions; the [company database](../company-database/CONTEXT.md) holds file-object references. The content store owns neither association.

## Language

**Content store**:
The platform's object store for published HTML and immutable patch file objects. It distinguishes an invalid object key, absent content and an unavailable store.
_Avoid_: file store (a patch's declared file primitive), blob store (one of the two layers, not the service), bucket

**Object key**:
The name under which bytes are held, referenced by a published version or a company's file index. It identifies content inside the store, never a location outside its boundary.
_Avoid_: file path, blob name (what the Azure layer calls it underneath)
