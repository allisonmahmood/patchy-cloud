---
name: patchy-files
description: Define a Patchy file store, save or retrieve bytes, page stored files, or display an image with a frame-local URL.
---

# File stores

<!-- PROTOTYPE for #315: tier 2 pages, handles and staged uploads; shareable stores. -->

Read `../patchy-loop/SKILL.md` first. Every readable row and stored file is available to whoever can open the patch: file names and hidden UI controls are not access rules. Tier 1 has no outbound access or client storage. Use local invented files while building, never download production bytes to seed development, and never edit generated output.

## Discover stores without reading files

Use the loop skill's discovery chain to find a tool by description with
`pnpm patchy list`, inspect its stores and reads with `list <patch>`, and inspect
a store's definition with `list <patch> <store>`. No match means none you can
use; check retired patches before concluding absence. These commands return
metadata, not file names or bytes. A store marked `shared: true` and
`declarable: true` can be read by a tier 2 patch through
`pnpm patchy add shared-store <patchId>/<store> --as <alias>` (see
`../patchy-shared-stores/SKILL.md`). Define a store owned by this patch when it
needs to save files.

## Tier 2: handles and uploads

On tier 2 the page has no `patchy.files.<store>`. Server functions read and write stores (`ctx.files`, see `../patchy-server/SKILL.md`) and return a `handle` with each file they select; the page only redeems handles and stages uploads:

```ts
import { patchy } from "../patchy/_generated/client.js";

const url = await patchy.files.url(file.handle); // frame-local blob URL for <img src>; URL.revokeObjectURL when done
await patchy.files.download(file.handle); // or download(handle, "name.pdf")
const upload = await patchy.files.stage(input.files[0], { contentType: input.files[0].type });
await patchy.server.deals.attach({ dealId, name: input.files[0].name, file: upload });
```

- In Preact prefer `useFileUrl(handle)` from `patchy/preact`: it returns `{ url, error }` and releases the URL when the handle changes or the component unmounts.
- Redemption is checked every time for this viewer and this document. `not_found`: the file was replaced or deleted after the handle was minted; re-run the query for the current handle. `access_denied`: the viewer can no longer reach the store (a shared source stopped sharing), or the handle belongs to another viewer or another patch. Neither replaces the page; show the failure where the file was.
- Bytes already shown or downloaded stay with the viewer; nothing claws them back.
- A content type is a claim. `stage` records the one you pass; the action receiving the Upload sees it and Patchy's measured `size`, and decides.
- A staged Upload is single-use and bound to this viewer and this document; pass it to one action.

## Define and use a store (tier 1)

Import `files` from `patchy/config` and add
`files: { attachments: files("Note attachments keyed by note id and filename.") }`
to the config, then run `pnpm patchy refresh`. A store belongs to the patch, not
a version, and needs no bucket configuration. `files("…", { shared: true })`
shares the whole store with the company: every file in it becomes readable by
patches that declare it, including files your own handlers would not select. To
share only some files, put them in a second store.

The required first argument is a nonblank description of one stored object,
its key convention, and relevant units or formats. For example, "Daily
temperature exports keyed by YYYY-MM-DD.csv; readings are degrees Celsius."
Use distinct names for tables and file stores. Publishing a store definition
replaces its description; omission and rollback preserve it. Description-only
changes do not advance the schema revision.

From `src/main.ts`:

```ts
import { patchy } from "../patchy/_generated/client.js";

const attachments = patchy.files.attachments;
await attachments.put("examples/note.txt", new TextEncoder().encode("Invented local attachment"), {
  contentType: "text/plain"
});
const bytes = await attachments.get("examples/note.txt");
const page = await attachments.list({ prefix: "examples/", limit: 20 });
```

Run this against the local dev runtime when available; this release's generated client does not by itself provide that runtime or its broker. Do not replace missing local support with direct cloud requests. For an image already saved in the local store, set an image element's `src` to `await attachments.url("examples/photo.png")`.

## Operations and limits

- `put(name, bytes, { contentType })` accepts `Uint8Array`, `ArrayBuffer` or `Blob`; it replaces the named file and returns null. Replacement stores new immutable bytes and changes the name's pointer.
- `get(name)` returns `Uint8Array` bytes. Retrieval checks access live and is not publicly cacheable.
- `list({ prefix?, limit?, cursor? })` returns `{ files, cursor }`. Each entry has `name`, `size`, `contentType`, `updatedAt`; it is metadata, not bytes. Pass a non-null cursor to the same listing for the next page and stop on null.
- `delete(name)` removes the name, returns null and is idempotent.
- `url(name)` fetches through the broker and returns a cached frame-local blob URL. It is not a public URL, a stable link to share or a way to evade access checks. Client `close()` releases its resources when the client is no longer used.

Files are at most 20 MiB. Names are 1–512 UTF-8 bytes in slash-separated segments, with neither `.` nor `..` segments. Choose a content type matching the bytes. Uploaded HTML and SVG stay bytes; they are never served as active documents at a file URL. The sandbox allows blob/data images, fonts and media, not outbound URLs or in-frame downloads.

File writes act as the viewer and are logged for company admins; public patches cannot use stores (`not_available_on_public`). For `unknown_outcome` reconcile by reading the name before offering a deliberate retry, never automatically replaying a write.

Omitting a store from config makes it unreachable to that version but keeps its data. Rollback and version cleanup never delete a patch's files. Local files live under `.patchy/`; deleting that directory destroys local files and rows. Keep reproducible local examples in source or fixtures, not production copies.
