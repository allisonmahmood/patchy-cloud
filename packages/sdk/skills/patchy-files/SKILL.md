---
name: patchy-files
description: Define a Patchy file store, save or retrieve bytes, page stored files, or display an image with a frame-local URL.
---

# File stores

Read `../patchy-loop/SKILL.md` first. Every readable row and stored file is available to whoever can open the patch: file names and hidden UI controls are not access rules. Tier 1 has no outbound access or client storage. Use local invented files while building, never download production bytes to seed development, and never edit generated output.

## Define and use a store

Import `files` from `patchy/config` and add `files: { attachments: files() }` to the config, then run `pnpm patchy refresh`. A store belongs to the patch, not a version, and needs no bucket configuration.

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
