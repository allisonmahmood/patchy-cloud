---
title: Primitives
description: The tables and file stores a patch owns, the shared tables and stores it can read, and the member directory.
---

A patch stores its data in **primitives** Patchy provides. It defines the ones it owns, its tables and file stores, in `patchy.config.ts`, and Patchy creates them when the patch is published. A tier 2 patch can also declare primitives it reads but doesn't own: other patches' shared tables and stores, and the company's member directory.

## Tables

A table is defined with a description and its columns, and a file store with a description:

```ts
// patchy.config.ts
import { defineConfig, files, table, t } from "patchy/config";

export default defineConfig({
  name: "team-notes",
  tier: 1,
  tables: {
    notes: table(
      "One team note per id; parent identifies another note.",
      {
        title: t.text(),
        body: t.text().optional(),
        done: t.boolean().default(false),
        parent: t.ref("notes").optional()
      },
      { indexes: { byDone: ["done"] } }
    )
  },
  files: { attachments: files("Note attachments keyed by note id and filename.") }
});
```

The description says what one row is, which keys identify or link it, and the units of its numbers; agents read it when they look for data to reuse.

- **Columns** are `text`, `integer`, `number`, `boolean`, `timestamp`, `json`, `ref` (a typed row id, indexed but not a foreign key) and `member` (a company user, on tier 2). Any column can be optional, and every kind but `member` can have a default.
- **Every row** gets an `id`, `createdAt` and `updatedAt` from Patchy.
- **Operations** are `get`, `getMany`, `list`, `insert`, `insertMany`, `update` and `delete`. `list` reads one page through an index, 100 rows by default and at most 1,000, with a cursor for the next page. `insertMany` writes all its rows or none.
- **Live reads.** A page can subscribe to a `list` or `get` with `useQuery`, so a colleague's write shows without a reload.

On tier 1, the page calls the table directly, as the viewer:

```ts
import { patchy } from "../patchy/_generated/client.js";

const note = await patchy.tables.notes.insert({ title: "Book the venue" });
const open = await patchy.tables.notes.list({ index: "byDone", eq: { done: false }, limit: 20 });
await patchy.tables.notes.update(note.id, { done: true });
```

On tier 2, handlers use the same operations through `ctx.tables`, and the page calls the handlers.

### Who reads and writes

On tier 1, every colleague and guest who can open the patch can read and write every row of its tables, as themselves, while a public page reads none. Hiding rows in the page is not access control. On tier 2, the page has no direct table access: handlers decide what each viewer reads and changes, and their writes to the patch's own tables act as the patch. Every write is recorded for the company's admins.

### Changing a published schema

Once a patch is published, its schema only grows. A publish can add tables, file stores, optional or defaulted columns and non-unique indexes. Retyping a column, changing whether it is optional or its default, or adding a required column to an existing table is refused with `not_additive`, naming the change and its fix.

Nothing is dropped. A table or column left out of the config keeps its data and is reported as unused; a renamed table is a new, empty table beside the old one.

## Files

A **file store**, such as `attachments` above, holds files by name. Its operations are `put`, `get`, `list` and `delete`. Names are up to 512 bytes, in `/`-separated segments; a file is at most 20 MiB. A page shows a stored image through a URL that lives only in its frame, and downloads go through Patchy's shell around the page, not the page itself. Patchy never serves a stored file at a public URL, and an uploaded HTML or SVG file stays bytes, never a page.

On tier 2, a page uploads by staging the bytes and handing the upload to an action, which saves it into a store. Lists of files carry handles the page uses to show or download one file; each use checks the viewer's access again.

## Shared tables and stores

A patch can share a table or a whole file store with the rest of its company, with `shared: true` in the table's options (`{ indexes: { byDone: ["done"] }, shared: true }`) or the store's (`files("…", { shared: true })`). Another tier 2 patch in the same company declares it by the source patch's id, then reads it in its handlers:

```sh
pnpm patchy add shared-table <patchId>/notes --as notes
```

Shared tables and stores are read-only to the patches that declare them. Each read is made as the viewer: it works only while the viewer can open the source patch and the source still shares it. Someone the consuming patch reaches but the source doesn't is refused on those reads, while everyone else keeps working. A source patch can't stop sharing, be retired or be deleted while live patches read it, unless its owner forces it after seeing which patches break.

To add fields of its own to shared rows, a patch keeps its own table keyed by their ids and joins the two in its handler. There are no shared writes.

## The member directory

A tier 2 patch reads the company's people through the member directory:

```sh
pnpm patchy add members
```

Handlers then list and search people, 50 to a page, matching the start of a name or email, and resolve stored user ids to `{ id, name, email, admin, active }`, up to 1,000 at a time. A `member` column stores a user id and accepts only a current member of the company, or one of the patch's guests. Deactivated users still resolve, marked inactive, so an old assignment keeps its name.

The directory comes from Patchy, never from rows a patch copies, so it includes colleagues who have never opened the patch.

## Where it lives

Each company's patch tables live in a database of the company's own, each patch's in a namespace of its own inside it, and file bytes are stored by patch. A patch with no tables or file stores needs none of it. While a patch is built, `patchy dev` runs the same operations over local data on the builder's computer.
