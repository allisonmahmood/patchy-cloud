---
name: patchy-files
description: Define a Patchy file store, stage or discard a tier 2 upload, adopt it in an action, save or retrieve bytes, page stored files, or display an image with a frame-local URL.
---

# File stores

Read `../patchy-loop/SKILL.md` first. On tier 1, every stored file is available to whoever can open the patch; file names and hidden UI controls are not access rules. Tier 2 uses `ctx.files` in handlers, not named stores on the page client. Use local invented files while building, never download production bytes to seed development, and never edit generated output.

For files generated in the page, use the Core method
`patchy.download(name, data)`, not a stored-file upload followed by download.
It works without a store, including on public tier 1 patches. See
`../patchy-loop/SKILL.md` for CSV export, the shell's approval action and limits.

## Discover stores without reading files

Use the loop skill's discovery chain to find a tool by description with
`pnpm patchy list`, inspect its stores and reads with `list <patch>`, and inspect
a store's definition with `list <patch> <store>`. No match means none you can
use; check retired patches before concluding absence. These commands return
metadata, not file names or bytes. A shared, openable store is
`declarable: true`; read `../patchy-shared-stores/SKILL.md` to declare it.
Define a store owned by this patch when it needs to save files.

## Define and use a store

Import `files` from `patchy/config` and add
`files: { attachments: files("Note attachments keyed by note id and filename.") }`
to the config, then run `pnpm patchy refresh`. A store belongs to the patch, not
a version, and needs no bucket configuration.

The required first argument is a nonblank description of one stored object,
its key convention, and relevant units or formats. For example, "Daily
temperature exports keyed by YYYY-MM-DD.csv; readings are degrees Celsius."
Use distinct names for tables and file stores. Publishing a store definition
replaces its description; omission and rollback preserve it. Description-only
changes do not advance the schema revision.

To publish read access to every file in the store, use
`files("Company logos keyed by filename.", { shared: true })`. Sharing is
whole-store, not per file. Omission and rollback preserve sharing. Publishing
the store with `shared: false` or without `shared` unshares it; this refuses
while other live patches depend on it unless publishing with `--force`.
See `../patchy-shared-stores/SKILL.md` for consumer access and recovery.

From a tier 1 module under `src/`:

```ts
import { patchy } from "../patchy/_generated/client.js";

const attachments = patchy.files.attachments;
await attachments.put("examples/note.txt", new TextEncoder().encode("Invented local attachment"), {
  contentType: "text/plain"
});
const bytes = await attachments.get("examples/note.txt");
const page = await attachments.list({ prefix: "examples/", limit: 20 });
```

Run this through the local shell from `pnpm patchy dev`. For an image already
saved in the local store, set an image element's `src` to
`await attachments.url("examples/photo.png")`.
On tier 2, queries use `ctx.files.<store>.list` and `.stat` for metadata;
actions use the store's byte operations. Every list entry and non-null stat
result carries a host-minted `handle`. Return it with `t.fileHandle()` in the
handler's result schema. The page calls those handlers, then uses
`patchy.files.url(handle)` or `patchy.files.download(handle, filename?)`.
For browser uploads, use staging below. See `../patchy-server/SKILL.md` for
handler kinds and the development boundary.

## Tier 2 selection and display

What the page sees is what handlers return. A handle freezes that selection
until the query reruns; filtering by viewer is the patch's code, not a UI filter.
To cut off a file when a record narrows to private, is handed over or is deleted,
re-put or delete it; handles already selected keep redeeming until then.
Bytes already shown or downloaded cannot be recalled.

`patchy.files.url(handle)` returns a frame-local blob URL, never a shareable
HTTP URL. Every call rechecks access. For Preact images, use
`useFileUrl(handle)` from `patchy/preact`; render its `{ url, error }`, including
the error. It drops a stale image on failure and releases the URL on unmount.
`patchy.files.download(handle, filename?)` offers the file in Patchy's shell;
the viewer clicks Download there. The default filename is the last segment of
the stored name, as on tier 1: `logos/company.svg` downloads as `company.svg`.
An explicit filename must satisfy the file-name rules below; empty names are
`invalid_request`, not an instruction to choose a browser-generated name.
`Not now` discards the offer, and closing or reloading loses pending downloads.

Handles are 57 characters, with no filename or expiry clock, and count against
page and result bounds. They bind the viewer, company, consuming patch, loaded
version, source store and exact object. Another viewer or patch cannot redeem
them. Publishing preserves handles in eligible open versions. Replacement or
deletion makes an old handle `not_found`; unsharing or lost access makes it
`access_denied`. Replacement takes precedence if both happen. The signed-in
shell is required on every redemption; a handle is not a login or entitlement.
Redemptions are reads and are not logged.

## Tier 2 staged uploads

Call `patchy.files.stage(bytes, { contentType })` on the page. It accepts
`Uint8Array`, `ArrayBuffer` or `Blob` and returns a single-use `Upload`; the
shell writes the bytes without sending them through server code. Pass that
Upload to an action argument declared with `t.upload()`.

In the action, inspect `upload.size` and `upload.contentType`, then call
`ctx.files.attachments.put(name, upload)` to adopt it into a store the loaded
version defines. Patchy resolves the metadata before your handler runs, so
`size` is authoritative even if the caller altered it. A content type is a
claim, not proof of format. Adoption keeps the staged content type and writes
a pointer without copying bytes.

When a person cancels before adoption, call `patchy.files.discard(upload)`.
The Upload binds its viewer, consuming patch and loaded version, and expires
after one hour. Adoption and discard race on the same row; whichever commits
first wins. An expired, consumed, discarded or differently bound Upload is
`not_found`. An object id is never adoption authority.

Stage at most 20 MiB per upload, with at most 16 outstanding stages and 100 MiB
per viewer per patch. Company capacity defaults to 1 GiB. Oversize files return
`too_large`; outstanding quotas return `limit_exceeded` with the limit id.
Staging and discard are unlogged transport. Adoption is a logged file write.

Put followed by a mutation is not atomic. If the mutation fails, the file
remains. Present that partial outcome to the person and offer an intentional
repair or retry; do not report that nothing was saved or replay the action.
Exercise this path in `patchy dev`, including cancelling and selecting again.

## Operations and limits

- `put(name, bytes, { contentType })` accepts `Uint8Array`, `ArrayBuffer` or `Blob`; it replaces the named file and returns null. Replacement stores new immutable bytes and changes the name's pointer.
- `get(name)` returns `Uint8Array` bytes. Retrieval checks access live and is not publicly cacheable.
- `list({ prefix?, limit?, cursor? })` returns `{ files, cursor }`. Each entry has `name`, `size`, `contentType`, `updatedAt`; it is metadata, not bytes. Pass a non-null cursor to the same listing for the next page and stop on null.
- `delete(name)` removes the name, returns null and is idempotent.
- `url(name)` fetches through the broker and returns a cached frame-local blob URL. It is not a public URL, a stable link to share or a way to evade access checks. Client `close()` releases its resources when the client is no longer used.

Files are at most 20 MiB. Names are 1–512 UTF-8 bytes in slash-separated segments, with neither `.` nor `..` segments. Choose a content type matching the bytes. Uploaded HTML and SVG stay bytes; they are never served as active documents at a file URL. The sandbox allows blob/data images, fonts and media, not outbound URLs or in-frame downloads.

Tier 1 file writes act as the viewer; tier 2 file writes act as the patch. Both are logged for company admins. Public patches cannot use stores (`not_available_on_public`). For `unknown_outcome` reconcile by reading the name before offering a deliberate retry, never automatically replaying a write.

Omitting a store from config makes it unreachable to that version but keeps its data. Rollback and version cleanup never delete a patch's files. Local files live under `.patchy/`; deleting that directory destroys local files and rows. Keep reproducible local examples in source or fixtures, not production copies.
