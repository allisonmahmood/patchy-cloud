# Content store

Where a patch's bytes go. `packages/content-store` owns one `ContentStore` service — put, get and delete an object by key — and its two implementations: a filesystem layer for `pnpm dev` and the tests, and an Azure Blob layer for the deployment. Which one runs is wiring in `apps/server/src/Server.ts` (Azure when `AZURE_STORAGE_CONTAINER` is set), not an operator's choice. Nothing here knows what a patch is: the keys are handed in by the capability that records them, `patches`' upload contract and expiry sweep.

## Language

**Content store**:
The platform's object store for a patch's bytes, one HTML object per patch version, addressed by object key. A failure is one of three: the key names nothing (`InvalidObjectKey`), the key holds nothing (`ObjectNotFound`), or the store could not carry the operation out (`StoreUnavailable`, with the disk's or the blob service's own error as `cause`).
_Avoid_: storage (reserved for the later per-patch file primitive), blob store (one of the two layers, not the service), bucket

**Object key**:
The path a patch version's bytes are stored under, chosen by the caller and recorded on the version row. Relative to the store's root, never above it: the filesystem layer refuses a key that would leave its directory.
_Avoid_: file path, blob name (what the Azure layer calls it underneath)
