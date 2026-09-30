---
name: patchy-members
description: Assign company users with t.member(), list or search candidates, resolve stored owners, subscribe to membership changes, or remove the members declaration.
---

# Member directory

Read `../patchy-loop/SKILL.md` first. The directory belongs to the patch's company. Patchy owns its data; a visitor table cannot replace it because colleagues may never have opened the patch.

## Declare and use

1. Run `pnpm patchy add members`. It adds `uses: { members: { kind: "members" } }` and generates this skill and the typed client. The alias is always `members`; there is no source id, revision stamp or fixture file. A hand-written `members()` declaration imported from `patchy/config` is equivalent after refresh. A patch may declare the directory without owning any table.
2. For assignments, add `owner: t.member()` to a table, or `t.member().optional()` if the owner may be null. `t.member().default("user-id")` supplies an insert default, which faces the same eligibility check as an explicit assignment. Declare an index yourself if you filter rows by owner. Config refuses member columns without the declaration.
3. Use `patchy.members` on a tier 1 page, or `ctx.members` in tier 2 queries, mutations and actions. A tier 2 page calls its generated handlers, never the directory directly. `t.member()` is columns-only; handler args use `t.text()` for an id and results use ordinary field schemas or `t.row("table")` for a row containing member columns.
4. Exercise the screen through both `url` and `colleagueUrl` from `pnpm patchy dev --json`. Both list the same two active candidates: the machine token's user and the non-admin fixture colleague. Dev imports no company roster and simulates no membership, role or other authority changes.

## Candidates and resolution

`list(options?)` and `search(text, options?)` return `{ rows, cursor }`, with fixed pages of 50 candidates. Options contain only `cursor`. Candidates today are every active user of the patch's company. Public sharing does not widen that set. Future audience restrictions may narrow it, so `active` alone is not a promise that someone is assignable.

Search matches a case-insensitive prefix of the full name or email. `"ann"` finds Anna, not Joanne. `%` and `_` are literal characters, not wildcards. It is not fuzzy search or surname matching. Keep the same search when reusing an opaque cursor; start again when it changes. Null means there is no next page. Results have deterministic ordering.

`get(id)` returns `{ id, name, email, admin, active }` or null. `getMany(ids)` accepts at most 1,000 ids and returns one member or null for every input position, preserving duplicates and order. Both resolve deactivated users with `active: false`. Unknown and other-company ids return null.

Table reads return ids, not joined directory data. Resolve a page's distinct owners once:

```ts
const page = await patchy.tables.tasks.list();
const ids = [...new Set(page.rows.flatMap((row) => (row.owner === null ? [] : [row.owner])))];
const resolved = await patchy.members.getMany(ids);
const owners = new Map(ids.map((id, index) => [id, resolved[index]]));
```

Render a deactivated owner as having left, and handle null as an unresolved owner. Do not erase the stored id just because resolution or access failed.

## Live screens and authority

All four tier 1 reads have `.subscribe(args, onSnapshot)` and work with `useQuery` from `patchy/preact`. List takes its options or `undefined`; get takes an id; getMany takes an id array. Search uses an object for subscriptions and hooks: `search.subscribe({ text: "ann" }, onSnapshot)` or `useQuery(patchy.members.search, { text: "ann" })`. One-shot search also accepts that object.

Snapshots contain `{ status, data, error, loading }`. Render the whole result and show failures separately from retained data. Joining, deactivation, reactivation, and name, email or role changes wake directory subscriptions. Tier 2 query handlers acquire the directory dependency through their callbacks; mutations and actions do not. Server context methods do not expose browser subscriptions.

Directory reads use the platform database, outside a query's company-database snapshot. A query combining table rows and directory data does not observe one atomic snapshot of both. The directory is refused outside the company, including outsiders opening a public tier 1 patch. A lower-tier document of a patch now serving tier 2 still gets only `me`.

## Assignment checks and removal

An insert or changed member value must name a current candidate, otherwise the write is `invalid_row`. This applies to defaulted values and both tiers. An unchanged value passes even after its user is deactivated; copying that id into a new row is a new assignment and is refused. Deactivation never rewrites stored rows. A batch containing an invalid assignment writes no rows.

Eligibility is checked when the write arrives, not when the company transaction commits. A user deactivated during a mutation can still receive an assignment that already passed its check. Use the write result rather than treating an earlier candidate listing as an authorization guarantee.

`pnpm patchy remove members` refuses while any configured `t.member()` column exists. Remove those columns first, respecting the additive published-schema rules in `../patchy-tables/SKILL.md`. Successful removal removes the typed directory client and this skill. It does not alter company users or stored member ids.
