---
name: patchy-tables
description: Define Patchy-owned tables, read or mutate rows, add indexes, or change a published schema.
---

# Owned tables

Read `../patchy-loop/SKILL.md` first for the local-only workflow and tier 1 limits. Every readable row is available to whoever can open the patch; a browser filter is not authorization. Tier 1 has no outbound access or client storage. Use invented local rows, never production data, and leave generated files untouched.

## Define, refresh, use

In `patchy.config.ts`, import `table` and `t` from `patchy/config` and put the definition in `tables`:

```ts
notes: table(
  {
    title: t.text(),
    body: t.text().optional(),
    done: t.boolean().default(false),
    parent: t.ref("notes").optional()
  },
  { indexes: { byDone: ["done"] } }
);
```

Run `pnpm patchy refresh`, then use the generated client from application source:

```ts
import { patchy } from "../patchy/_generated/client.js";

// Exercise this against the local dev runtime, never to seed production.
const note = await patchy.tables.notes.insert({ title: "Invented local note" });
const page = await patchy.tables.notes.list({
  index: "byDone",
  eq: { done: false },
  limit: 20
});
await patchy.tables.notes.update(note.id, { done: true });
```

The client is present in this release; running these calls needs the separate local dev runtime and broker. If unavailable, finish config, source and typechecking and report the runtime boundary rather than substituting a production connection.

## Row contract

Kinds: `t.text()`, `t.integer()`, `t.number()`, `t.boolean()`, `t.timestamp()` (ISO string), `t.json()` (read as `unknown`), `t.ref("notes")` (typed row id). Refs are indexed automatically but are not foreign keys: deleting a target may leave dangling refs. Validate unknown JSON before using its fields.

Each row has reserved `id`, `createdAt` and `updatedAt`. Patchy supplies and maintains them; never put them in insert or update input. `Row`, `Insert` and `Update` types from `patchy/config` can be inferred from `typeof config` and the table name.

- Insert: required fields must be supplied; omitted optional fields become null; omitted defaulted fields take their default. Defaulted is not nullable. Explicit null is accepted only for optional fields. Unknown fields are refused.
- Update: omitted fields stay unchanged; null clears an optional field; required/defaulted null is refused. `update(id, patch)` returns the updated row or `row_not_found`.
- `get(id)` returns a row or null. `getMany(ids)` preserves input order with null for each missing or dangling id.
- `insert(row)` returns the inserted row. `insertMany(rows)` returns the inserted rows and is all-or-nothing.
- `delete(id)` is idempotent, returning null even when already absent. Writes are last-write-wins; there is no cross-table transaction or automatic mutation retry.

Rows are bounded to 1 MiB, batches to 1,000 items and 8 MiB, list/getMany results to 8 MiB. Handle `invalid_row`, `unique_violation`, `row_not_found` and `too_large` as visible failures. For a lost reply, follow the loop skill's `unknown_outcome` rule.

## Indexed pages

`list({ index?, eq?, range?, order?, limit?, cursor? })` returns `{ rows, cursor }`. Pages default to 100, maximum 1,000. Without an index, order is `(createdAt, id)`, newest first. With an index, equality must cover its leading columns; at most one trailing column can have a range, such as `range: { column: "createdAt", gte: "2026-01-01T00:00:00.000Z" }` on the built-in index. `order` is `"asc"` or `"desc"`; id breaks ties.

Pass a non-null returned cursor to the same query for the next page. Cursors are opaque and bound to index/order, not snapshots. Stop on null; a changed query starts a fresh page. Declare the index the UI needs and filter on the server instead of downloading all rows. Index definitions may use `["column"]` or `{ columns: ["column"], unique: true }`.

## Published schemas are additive

Before first publish local schema changes are disposable. Once the repo has a patch id, the intended local runtime uses the published inventory as its baseline and applies the same diff as publishing; resetting local data does not reset that baseline.

Add new tables, stores, optional/defaulted columns or non-unique indexes. Existing rows receive a new constant default, or the publish time for a new `"now"` default. Unique indexes belong only on newly created tables. Ordinary index creation blocks writers while it runs.

Retyping, changing optionality or defaults, adding a required column or uniqueness to an existing table, changing an existing index, and omitting a required column are `not_additive`. Follow the refusal's object, change and fix: keep the old column and add a compatible new one.

Omitting a table, store, optional/defaulted column or index keeps its data and reports it unused; it does not delete it. A rename adds a new empty table beside the kept old one. Omitted defaults and unique indexes continue to apply. A compatible redefinition can expose the kept table again. `shared: true` lets other patches declare read-only access; see `../patchy-shared-tables/SKILL.md` when available. Omission does not unshare a table, and changing a version pointer does not change live sharing.
