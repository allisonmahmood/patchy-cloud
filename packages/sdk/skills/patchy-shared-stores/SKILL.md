---
name: patchy-shared-stores
description: Declare another patch's shared file store, read its files from tier 2 handlers, author local file fixtures, or diagnose source access and sharing changes.
---

# Shared file stores

Read `../patchy-loop/SKILL.md` first. A shared store publishes read access to every file, not selected names. A declaration grants no authority: each read requires a viewer who can still open the source and a store that is still shared. Shared stores are read-only.

Reading another patch's store is tier 2's: queries and actions read it through `ctx.shared`, and the page calls those handlers. A tier 1 page reaches only its own patch, so declaring a shared store on a tier 1 repo is refused with `tier_mismatch`; move the repo to tier 2 first, as `../patchy-loop/SKILL.md` says. Any tier can share its own stores out.

## Declare, seed locally, read

1. Find a source through `pnpm patchy list --json`, then inspect `list <patch> <store> --json`. Choose `declarable: true` and carry its canonical patch id into the declaration. For `not_shared`, ask the named owner; for `source_off`, arrange restoration. Follow the loop skill's state flags rather than treating a retired source as absent.
2. Run `pnpm patchy add shared-store <patchId>/<store> --as assets`. It adds `{ kind: "sharedStore", patchId: "<patchId>", store: "<store>" }` under `uses`, then generates the client, context, fixture stub and this skill. When editing config by hand, `sharedStore("<patchId>", "<store>")` from `patchy/config` is equivalent; run `pnpm patchy refresh` afterwards.
3. Read the alias entry in `patchy/_generated/index.json` and its context. They identify the source store and its revision. Keep generated ids and revision stamps unchanged.
4. Put invented files in `fixtures/shared-assets/`. The generated `README.md` names the source store; it is metadata, not a file returned by dev. Subdirectories become part of file names. Dev infers content types from extensions, ignoring case: `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `pdf`, `txt`, `csv`, `json` and `html`. Other extensions or no extension use `application/octet-stream`; bytes are not inspected or changed. Refresh leaves an existing fixture directory untouched. Dev reloads the files at start, including additions and deletions, so restart after edits. Never copy production bytes to seed development. Authority changes are not simulated locally.
5. Run `pnpm typecheck` and `pnpm patchy dev --json`. Exercise reads through the local shell on both `url` and `colleagueUrl`, calling the queries or actions that read the store.

## Reading

Queries use `ctx.shared.assets.list(options?)` and `.stat(name)` for metadata. `stat` returns null when the name is missing. Actions expose those methods and `.get(name)` for `Uint8Array` bytes. Mutations cannot read shared stores. Neither queries nor actions can write a shared store or use browser `url` and `download` methods. The page calls the generated handler client; see `../patchy-server/SKILL.md` for handler contracts.

Every list entry and non-null stat result includes an authorised `handle`.
Return selected handles through a `t.fileHandle()` result descriptor; the page
uses `patchy.files.url(handle)`, `.download(handle, filename?)` or
`useFileUrl(handle)` from `patchy/preact`. Every redemption rechecks source
access and sharing. See `../patchy-files/SKILL.md` for the patch's filter and
the re-put/delete rule for cutting off previously selected files.

`list({ prefix?, limit?, cursor? })` returns `{ files, cursor }`. Entries contain `name`, `size`, `contentType`, `updatedAt` and `handle`. Pages default to 100 and allow at most 1,000 entries. Keep the same prefix when passing a non-null cursor for the next page; null ends pagination. Files are at most 20 MiB. Names are 1–512 UTF-8 bytes in slash-separated segments, with neither `.` nor `..` segments. Uploaded HTML and SVG remain bytes, never active documents.

Subscribed queries track both the source store and its patch lifecycle. Source changes invalidate their metadata snapshots; a source refusal remains recoverable after access or sharing returns.

The source's tier does not restrict consumption: a tier 2 consumer can read a store a tier 1 patch shares.

## Sharing and recovery

A source publishes sharing with `files(description, { shared: true })`. Omitting the store and rolling back either source or consumer preserve sharing. Publishing the store with `shared: false` or without `shared` unshares it. Unshare, retire and delete refuse while live consumers depend on the store unless forced; the refusal names those consumers.

After forced unshare or loss of source access, the next read returns `access_denied`, including bytes and downloads. Do not turn that refusal into an empty successful listing. Resharing or restoring the same source lets consumers recover unchanged. A new patch under its old name never replaces the canonical source id. Public patches cannot use shared stores.

Generation uses cumulative source inventory, not only its active manifest. A stale revision produces a publish warning; refresh updates the declaration metadata and stamp without replacing invented files. `pnpm patchy remove assets` removes the declaration and generated files, and this skill when no shared-store declarations remain. It leaves the fixture directory for you.
