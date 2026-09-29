---
name: patchy-tables
description: Define Patchy-owned tables, read or mutate rows, subscribe screens with list/get or useQuery, add indexes, or change a published schema.
---

# Owned tables

Read `../patchy-loop/SKILL.md` first for the local-only workflow and tier limits. On tier 1, every readable row is available to whoever can open the patch; a browser filter is not authorization. Tier 2 enforces rules in handlers using `ctx.tables`; the page has no direct table client. Use invented local rows, never production data, and leave generated files untouched.

## Check existing tables first

Before duplicating company data, use the loop skill's discovery chain:
`pnpm patchy list` for descriptions, `list <patch>` for tables and reads, then
`list <patch> <table>` for keys, types, defaults, refs, indexes and revision.
Check retired patches before concluding absence; no match means none you can
use. If a table is `declarable: true`, add it with
`pnpm patchy add shared-table <patchId>/<table>` using its canonical id and
follow the generated shared-table skill. Define an owned table when the patch
needs its own writes; another patch's shared table stays read-only.

## Define, refresh, use

In `patchy.config.ts`, import `table` and `t` from `patchy/config` and put the definition in `tables`:

```ts
notes: table(
  "One team note per id; parent identifies another note.",
  {
    title: t.text(),
    body: t.text().optional(),
    done: t.boolean().default(false),
    parent: t.ref("notes").optional()
  },
  { indexes: { byDone: ["done"] } }
);
```

The first argument is a required nonblank description. State what one row
represents, which keys identify or link it, and the units of numeric values
when applicable. For example, an expense table could say "One expense per id;
employeeId identifies the submitter; amount is integer USD cents." A label
like "expenses table" does not explain the data. Table and file-store names
must be distinct across the config.

Run `pnpm patchy refresh`, then use the generated client from tier 1 application source:

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
On tier 2, use these row operations on `ctx.tables` inside the handler kinds
described in `../patchy-server/SKILL.md`, and call those handlers from the page.

## Row contract

Kinds: `t.text()`, `t.integer()`, `t.number()`, `t.boolean()`, `t.timestamp()` (ISO string), `t.json()` (read as `unknown`), `t.ref("notes")` (typed row id). Refs have an automatic index named exactly after their column: the example's `parent` ref is queried with `list({ index: "parent", eq: { parent: note.id } })`. They are not foreign keys; deleting a target may leave dangling refs. Validate unknown JSON before using its fields.

Each row has reserved `id`, `createdAt` and `updatedAt`. Patchy supplies and maintains them; never put them in insert or update input. `Row`, `Insert` and `Update` types from `patchy/config` can be inferred from `typeof config` and the table name.

- Insert: required fields must be supplied; omitted optional fields become null; omitted defaulted fields take their default. Defaulted is not nullable. Explicit null is accepted only for optional fields. Unknown fields are refused.
- Update: omitted fields stay unchanged; null clears an optional field; required/defaulted null is refused. `update(id, patch)` returns the updated row or `row_not_found`.
- `get(id)` returns a row or null. `getMany(ids)` preserves input order with null for each missing or dangling id.
- `insert(row)` returns the inserted row. `insertMany(rows)` returns the inserted rows and is all-or-nothing.
- `delete(id)` is idempotent, returning null even when already absent. Tier 1 direct writes are last-write-wins; they have no cross-table transaction or automatic mutation retry. Tier 2 mutation handlers group their owned-table operations into one `SERIALIZABLE` transaction, with up to three whole-handler attempts. See `patchy-server` for `write_conflict` and keyed `retry()`.

Rows are bounded to 1 MiB, batches to 1,000 items and 8 MiB, list/getMany results to 8 MiB. Handle `invalid_row`, `unique_violation`, `row_not_found` and `too_large` as visible failures. For a lost reply, follow the loop skill's `unknown_outcome` rule.

## Indexed pages

`list({ index?, eq?, range?, order?, limit?, cursor? })` returns `{ rows, cursor }`. Pages default to 100, maximum 1,000. Without an index, order is `(createdAt, id)`, newest first. With an index, equality must cover its leading columns; at most one trailing column can have a range, such as `range: { column: "createdAt", gte: "2026-01-01T00:00:00.000Z" }` on the built-in index. `order` is `"asc"` or `"desc"`; id breaks ties.

Pass a non-null returned cursor to the same query for the next page. Cursors are opaque and bound to index/order, not snapshots. Stop on null; a changed query starts a fresh page. Declare the index the UI needs and filter on the server instead of downloading all rows. Index definitions may use `["column"]` or `{ columns: ["column"], unique: true }`.

## Subscribed screens

On tier 1 company pages, subscribe instead of re-reading after each write:

```tsx
import { useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

export function Notes() {
  const query = useQuery(patchy.tables.notes.list, { limit: 20 });
  return (
    <section>
      {query.loading && <p>Loading notes...</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.rows.map((note) => (
        <p key={note.id}>{note.title}</p>
      ))}
    </section>
  );
}
```

The framework-free forms are `list.subscribe(options, onSnapshot)` and
`get.subscribe(id, onSnapshot)`. They return an unsubscribe function. Both deliver
`{ status, data, error, loading }`; `data` is the whole `{ rows, cursor }` page
for list, or the row or null for get. Shared tables expose the same forms.
Render the whole latest result, not an appended row or a guessed local diff.
A successful write does not replace the subscribed result; its committed change
wakes the subscription.

`get` wakes at table grain, including when a previously missing row appears.
Identical queries share one subscription. Keep arguments JSON-compatible and
dispose framework-free subscriptions when their screen ends. A short remount
keeps the current result.

Transient errors keep the last value and recover through the stream. A permanent
error ends the subscription with its last value kept. Additional consumers,
short remounts and reconnects do not restart it. Render errors separately rather
than clearing the previous result. A shared-source refusal remains subscribed
so restoring sharing or the source can recover without changing the consumer.

There are at most 64 subscriptions per document, 256 per patch and 1,024 per
company. The newest is refused without evicting another. Each snapshot is at
most 8 MiB; an oversized result ends only that subscription. Public pages and
company Postgres reads do not support subscriptions.

## Published schemas are additive

Before first publish local schema changes are disposable. Once the repo has a patch id, the intended local runtime uses the published inventory as its baseline and applies the same diff as publishing; resetting local data does not reset that baseline.

Add new tables, stores, optional/defaulted columns or non-unique indexes. Existing rows receive a new constant default, or the publish time for a new `"now"` default. Unique indexes belong only on newly created tables. Ordinary index creation blocks writers while it runs.

Retyping, changing optionality or defaults, adding a required column or uniqueness to an existing table, changing an existing index, and omitting a required column are `not_additive`. Follow the refusal's object, change and fix: keep the old column and add a compatible new one.

Omitting a table, store, optional/defaulted column or index keeps its data and reports it unused; it does not delete it. A rename adds a new empty table beside the kept old one. The kept name stays taken: a new store cannot reuse an omitted table's name, nor a new table an omitted store's. Omitted defaults and unique indexes continue to apply. A compatible redefinition can expose the kept table again. `shared: true` lets other patches declare read-only access; see `../patchy-shared-tables/SKILL.md` when available. Omission does not unshare a table, and changing a version pointer does not change live sharing.

Publishing a table definition replaces its description. Omitting the table
preserves its description, and rollback leaves it unchanged. Description-only
changes do not advance the schema revision.
