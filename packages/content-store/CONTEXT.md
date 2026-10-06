# Content store

Where published patch bytes, patch file objects, SDK archives and generated platform release notes live, separate from their metadata. [Patches](../patches/CONTEXT.md) owns published versions; the [company database](../company-database/CONTEXT.md) holds file-object references. SDK distribution owns release metadata. The content store owns none of these associations.

## Language

**Content store**:
The platform's object store for published HTML and server bundles, immutable patch file objects, retained SDK archives and the shared release-notes document. It distinguishes an invalid object key, absent content and an unavailable store.
_Avoid_: file store (a patch's declared file primitive), blob store, bucket

**Object key**:
The name under which bytes are held, referenced by a published version, a company's file index or an SDK archive URL. It identifies content inside the store, never a location outside its boundary.
_Avoid_: file path, blob name

**SDK archive**:
The packed tooling package for a release, identified by the digest of its bytes. Once advertised, its URL remains valid across later releases and deployments.
_Avoid_: build cache, latest package
