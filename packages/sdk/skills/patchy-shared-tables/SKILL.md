---
name: patchy-shared-tables
description: Declare another patch's shared table, read its generated client, author its local fixture, or diagnose source access and schema revisions.
---

# Shared-table reads

Read `../patchy-loop/SKILL.md` first. Every readable row is available to whoever can open the patch, subject to the source's live access: UI filters are not authorization. Tier 1 has no outbound access or client storage. Build with invented local fixtures, never production rows, and never manually edit generated clients, context or revision stamps.

## Declare, seed locally, read

1. Run `pnpm patchy catalog`. It lists only shared tables whose source patch you can open. Copy the actual source patch id and table, not its address or name.
2. Run `pnpm patchy add shared-table <patchId>/<table> --as contacts`. It inserts `contacts: { kind: "sharedTable", patchId: "<patchId>", table: "<table>" }` into `uses` without changing imports, and generates client, context, fixture stub and this skill. When hand-editing config, you may instead import `sharedTable` from `patchy/config` and write the equivalent `contacts: sharedTable("<patchId>", "<table>")`; run `pnpm patchy refresh` afterwards.
3. Read the `contacts` entry in `patchy/_generated/index.json` and its context file. They identify the source definition, revision and indexes; use these fields rather than guessing the source's current application schema.
4. Fill `fixtures/shared-contacts.sql` with invented `INSERT` rows. Use the exact local namespace, quoted table and columns from the stub header, not the source patch's production namespace. For a stub listing a `title` column, include an invented value such as `'Local contact'` alongside any other required columns the header names. These inserts populate the local copy, not the source patch; runtime reads stay read-only.
5. Run `pnpm typecheck`, then read from the local dev shell when available. The local dev runtime and broker are separate work from this release's generation. Report an unavailable local runtime; never substitute a cloud read or copy production rows to make a fixture.

In application source, if the declaration's generated alias is `contacts`:

```ts
import { patchy } from "../patchy/_generated/client.js";

const page = await patchy.shared.contacts.list({ limit: 20 });
const first = page.rows[0];
if (first) {
  const current = await patchy.shared.contacts.get(first.id);
  // Render the row or the missing-row state when current is null.
}
```

## Read contract

The only methods are `get(id)`, `getMany(ids)` and `list({ index?, eq?, range?, order?, limit?, cursor? })`. There are no insert, update or delete methods on `patchy.shared`. `get` returns null for a missing row; `getMany` preserves input order with null per missing id.

`list` returns `{ rows, cursor }`, using the source's declared indexes. Equality covers leading columns and at most one trailing column has a range `{ column, gt?, gte?, lt?, lte? }`. Without an index, order is creation time and id, newest first. Pass the same query and a non-null cursor for the next page; null ends pagination. Pages default to 100, at most 1,000; getMany is bounded to 1,000 ids and 8 MiB, and list/getMany results to 8 MiB. Declare and use the appropriate index rather than fetching everything to filter in the browser.

## Access and revisions

A declaration grants no authority. Each call requires an admitted viewer who can still open the source and a table that is still shared. Public patches have no data access even for signed-in members. `patch_not_openable` during generation means the source is unavailable: restore access with the source owner or correct the declaration; company administration is at `/company`. Runtime access loss is `access_denied`; preserve the shell's notice rather than rendering an empty successful table.

Generation and fixtures use the source's cumulative inventory, not its active version's manifest. A source table omitted from a newer config still exists and remains shared until its owner explicitly changes sharing. Unsharing takes effect live; rollback does not restore sharing. A consumer's revision records the definition it generated against; the server validates source availability at publish and warns about an older shared-table stamp. Refresh to update client and context, never change stamps yourself.

`pnpm patchy remove contacts` removes the declaration and generated files, and removes this skill when no shared-table declarations remain. It deliberately leaves `fixtures/shared-contacts.sql` for you. Refresh never overwrites that existing fixture; amend its invented rows when the source definition changes.
