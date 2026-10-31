---
name: patchy-members
description: Assign company users or the patch's guests with t.member(), list or search candidates, resolve stored owners, subscribe to membership changes, or remove the members declaration.
---

# Member directory

Read `../patchy-loop/SKILL.md` first. The directory belongs to the patch's company. Patchy owns its data; a visitor table cannot replace it because colleagues may never have opened the patch.

The directory is tier 2's: handlers read it with `ctx.members`, and the page calls those handlers. A tier 1 page reaches only its own patch, so `patchy add members` on a tier 1 repo is refused with `tier_mismatch`; move the repo to tier 2 first, as `../patchy-loop/SKILL.md` says.

## Declare and use

1. Run `pnpm patchy add members`. It adds `uses: { members: { kind: "members" } }` and generates this skill and the typed client. The alias is always `members`; there is no source id, revision stamp or fixture file. A hand-written `members()` declaration imported from `patchy/config` is equivalent after refresh. A patch may declare the directory without owning any table.
2. For assignments, add `owner: t.member()` to a table, or `t.member().optional()` if the owner may be null. Member columns cannot have defaults; supply the id on each insert. Declare an index yourself if you filter rows by owner. Config refuses member columns without the declaration.
3. Use `ctx.members` in queries, mutations and actions. The page calls its generated handlers, never the directory directly. `t.member()` is columns-only; handler args use `t.text()` for an id and results use ordinary field schemas or `t.row("table")` for a row containing member columns.
4. Exercise the screen through `url`, `colleagueUrl` and `guestUrl` from `pnpm patchy dev --json`. All three list the same three active candidates: the machine token's user, the non-admin fixture colleague and the fixture guest. Dev imports no company roster and simulates no membership, grant, role or other authority changes.

## Candidates and resolution

`list(options?)` and `search(text, options?)` return `{ rows, cursor }`, with fixed pages of 50 candidates. Options contain only `cursor`. Candidates are the active users of the patch's company and the patch's guests: people at another company it is shared with, while their grant and account are active. Public sharing does not widen that set. Future audience restrictions may narrow it, so `active` alone is not a promise that someone is assignable.

Search matches a case-insensitive prefix of the full name or email. `"ann"` finds Anna, not Joanne. `%` and `_` are literal characters, not wildcards. It is not fuzzy search or surname matching. Keep the same search when reusing an opaque cursor; start again when it changes. Null means there is no next page. Results have deterministic ordering.

`get(id)` returns `{ id, name, email, admin, active }` or null, and a guest also carries `guest: true`. `name` is never blank: a user without one is named by their email's local part. `getMany(ids)` accepts at most 1,000 ids and returns one member or null for every input position, preserving duplicates and order. Both resolve deactivated users with `active: false`. They also resolve anyone holding a grant to any of the company's patches, so a shared table's guests resolve in every patch that reads it. A guest is never `admin`, and is `active: false` once their account is deactivated or none of their grants in the company is active. Unknown ids and everyone else at other companies return null.

Handler results are checked strictly, so a result schema that lists a member's fields without `guest` fails when a guest is returned. A guest receives what a `guest: true` handler returns, emails included.

Table reads return ids, not joined directory data. Resolve a page's distinct owners once, in the query that reads the rows:

```ts
const page = await ctx.tables.tasks.list();
const ids = [...new Set(page.rows.flatMap((row) => (row.owner === null ? [] : [row.owner])))];
const resolved = await ctx.members.getMany(ids);
const owners = new Map(ids.map((id, index) => [id, resolved[index]]));
```

Render an inactive owner as having left, or a guest as no longer shared with, and handle null as an unresolved owner. Do not erase the stored id just because resolution or access failed.

## Live screens and authority

A query that reads the directory is live: subscribe to it with `useQuery` from `patchy/preact`, and joining, deactivation, reactivation, name, email or role changes, and a guest's grant starting or ending rerun it. A guest's own account changes show at its next rerun. Query handlers acquire the directory dependency through their callbacks; mutations and actions do not. Server context methods do not expose browser subscriptions.

Snapshots contain `{ status, data, error, loading }`. Render the whole result and show failures separately from retained data.

Directory reads use the platform database, outside a query's company-database snapshot. A query combining table rows and directory data does not observe one atomic snapshot of both. The directory is refused outside the company. A page's direct directory call is refused `server_required` on every tier, and a lower-tier document of a patch now serving tier 2 still gets only `me`.

## Assignment checks and removal

An insert or changed member value must name a current candidate, otherwise the write is `invalid_row`. An unchanged value passes even after its user is deactivated or their grant ends; copying that id into a new row is a new assignment and is refused. Neither rewrites stored rows. A batch containing an invalid assignment writes no rows.

Eligibility is checked when the write arrives, not when the company transaction commits. A user deactivated during a mutation can still receive an assignment that already passed its check. Use the write result rather than treating an earlier candidate listing as an authorization guarantee.

`pnpm patchy remove members` refuses while any configured `t.member()` column exists. Remove those columns first, respecting the additive published-schema rules in `../patchy-tables/SKILL.md`. Successful removal removes the typed directory client and this skill. It does not alter company users or stored member ids.
