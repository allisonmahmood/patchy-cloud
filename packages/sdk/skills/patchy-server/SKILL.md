---
name: patchy-server
description: "Build tier 2 queries, mutations and actions; type helpers, handle refusals and mutation retries, and render subscribed results."
---

# Server handlers

Start with `patchy init <dir> --tier 2 --purpose "<purpose>"`. It installs the
Preact page, a starter `server/` module, config-bound generated builders and
the exact `workerd` managed pin with install scripts disabled. Inside the repo,
use `pnpm patchy`; read `patchy-loop` for changing an existing repo's tier.

Run `pnpm patchy dev --json` and open `url` as the machine user and
`colleagueUrl` as a fixed non-admin colleague. Both share disposable local data.
Queries, mutations, actions and subscriptions use the production handler engine
and callback gateway. `server/` saves atomically rebind without reloading the page;
new modules log a reminder to refresh types. Calls and nested calls in flight
finish on the old binding. Subscriptions rerun on the new one, discard crossing
results and end permanently if a handler is removed or its arguments no longer fit.
Failed builds retain the last good binding. `src/` saves still reload the shell.

`patchy dev` runs the same handler engine and callback path as production.
It does not reproduce production scheduling, operating capacity or containment. A handler
that spins forever times out, and a health check restarts the dev engine, which
can interrupt other calls in flight. Contract limits still apply; production
operating capacity does not. PGlite cannot prove hosted `busy` or `write_conflict`
behavior. Production hosting requires the fleet executor.

Fill `fixtures/shared-<alias>.sql` and `fixtures/postgres-<handle>.sql` with invented
rows for `ctx.shared` tables and Postgres `ctx.connections`; PostHog, Pidgeon and
Attio have no fixture, and actions read the real project, address or workspace
through the instance, as the publishing key's person for either viewer. Pidgeon's sends,
replies and triage are simulated in dev and never sent. Put invented shared files
in `fixtures/shared-<alias>/`; restart after fixture or config edits.
Read `dev.log` for each call's viewer, handler, outcome and milliseconds, `ctx.log`
output, each thrown error's message and stack, which browsers never receive, and
each simulated Pidgeon write with its recipients and subject.
Starting with `--json` records full wide events, invocation JSON and simulated
writes; `dev logs --json` returns `{ ok, log, text }`. No local runtime log rows
are written; the instance logs PostHog, Pidgeon and Attio dev reads.

When someone says a published patch is broken, read its log before guessing:
`pnpm patchy logs --failed --json`, or without `--failed` to see what led up to
it. Each entry gives the version, handler, outcome and code, who made the call
and any agent they called through, the correlation id a browser's failure shows, its `ctx.log` lines with a
thrown error's message and stack, and the steps it made, including writes that
succeeded before it failed. Stacks point into the minified bundle, so the
message is the clue. Pages hold up to 25 entries; continue with
`--before <next>` and filter with jq. Only the owner and admins can read it.
Reproduce the failure in `patchy dev` with fixtures, fix it, publish, and check
the log for new entries.

Publish builds HTML and a closed server module, records handler descriptors
and SDK imports, and sends both artifacts. The instance re-derives descriptors
from the stored bytes in a throwaway process. Mismatch, top-level throw,
unfinished initialization or unresolved imports return `invalid_manifest`,
exit 2. Keep module initialization bounded and side-effect-free.
`server/` below tier 2 is `tier_mismatch`; zero handlers publishes with a warning.
After adding, removing or renaming a server module, run `pnpm patchy refresh`.
Refresh alone regenerates the module list; publish refuses a stale list with
`stale_generated`. Renaming an export within an existing module changes its
type-only contract without requiring a new module list.

Tier 2 is company-only. Publishing to a public patch needs `--share company`;
public sharing is `tier2_not_public`. Older tier 1 pages lose direct operations
while tier 2 is served, with `server_required` and a reload notice. A rollback
to tier 1 reopens those pages' operations; tier 2 pages always use handlers.
If this patch has retained guest grants, a blocked connection, member directory,
member columns or another patch's shared table or store makes it unavailable to
guests. Publish still succeeds and reports the source and repair in `warnings`.
Removing the declaration or asking an admin to unblock the connection restores
source eligibility without removing the grants.

## Define the contract

Export handlers from `server/<module>.ts`, one directory level deep. Each export
must be a `query`, `mutation` or `action`; its name is `<module>.<export>`.
Keep reusable company code in `helpers/`, outside handler discovery. Import
builders and bound context types from `patchy/_generated/server.js`, and `t` and
`HandlerError` from `patchy/server`.
Each builder takes `{ description?, guest?, args, result, errors?, handler }`, and
`action` also takes `readOnly: true`. `args` is a field map; `result` is one
descriptor. The handler receives `(ctx, args)`.

An outside guest with a share may start only page handlers marked `guest: true`.
Queries, mutations and actions can all be marked. Unmarked sibling handlers may
still be called through a marked action's `ctx.run` under the usual nested-call
rules; the mark controls entry, not each internal call. Check the real viewer
where records or operations depend on that person. Guests cannot call `agent/`
tools. A tier 1 guest can write all owned tables and files, so use tier 2
handlers when guest access needs read-only or person-specific rules.

The generated builders bind the config's table types. A helper can accept
`QueryContext`, `MutationContext`, `ActionContext` or `ReadOnlyActionContext`
without repeating generics.
A type-only import of the server modules gives the page its handler names and
arguments; renaming a handler breaks callers at compile time. A helper's runtime
imports join its caller's dependency graph, so a helper that imports server code
also leaks it into any page that imports the helper. Keep shared helpers
browser-safe and use `import type` for server contracts.

Scalar descriptors are `t.text()`, `t.integer()`, `t.number()`, `t.boolean()`,
`t.timestamp()` and `t.json()`. Compose them with `t.object(fields)`,
`t.array(element)`, `t.enum(values)` and `t.nullable(value)`. `t.row("table")`
validates the full row, including its columns and system fields, not just its id.
Results are readonly.

A handler's `description` says what it does, and any handler value takes
`.describe(text)`, such as `t.text().describe("The customer's legal name.")`.
Every description is nonblank and at most 2,000 characters; the build refuses
others with `invalid_manifest`, naming the file, the handler and the fix. When
`t.nullable(value)` and its value are both described, the outer description
wins. Table columns take no `.describe()`: the types and config execution refuse
it, and the table's description covers its columns.

An argument field's `.optional()` permits an omitted key. It does not permit
null; use `t.nullable(...)` for null. A table column's `.optional()` instead means
nullable. `.default()`, `t.ref()` and `t.member()` remain table-only.
`t.fileHandle()` is results-only. `t.upload()` is allowed only in action arguments.

## Choose a kind

- A query reads owned tables, declared shared tables, and owned or shared file
  metadata. `ctx.tables` is read-only; `ctx.files.<store>` and shared store
  aliases under `ctx.shared` have `list` and `stat`, not byte reads.
  `stat` returns metadata or null; every metadata entry includes `handle`.
  Read only what the screen needs, using filters and bounded pages.
- An action reads and writes owned tables, reads shared tables, reaches declared
  connections and reads or writes file bytes. `ctx.files.<store>.put(name, bytes,
options?)` accepts `Uint8Array`, `ArrayBuffer` or `Blob`; `put(name, upload)`
  adopts a staged Upload without copying bytes. `get(name)` returns bytes and
  `delete(name)` removes the object. Shared stores expose `list`, `stat` and `get`, with no writes;
  read `../patchy-shared-stores/SKILL.md` for their access and fixture contract.
- A mutation reads and writes owned tables in one atomic transaction. It cannot
  read file metadata. Use queries for file lists and metadata, and actions for
  file bytes, integrations and `ctx.run`.
- A read-only action is an action declared `readOnly: true`. Its
  `ReadOnlyActionContext` keeps an action's reads and drops its writes:
  `ctx.viewer`, `ctx.log`, declared `ctx.members`, table `get`, `getMany` and
  `list`, shared reads, file `list`, `stat` and `get`, `ctx.connections`, and
  `ctx.run` for queries only. A write is a type error, and Patchy refuses one
  forced past the types with `access_denied`. Only actions take the flag.

Queries and read-only actions are reads; every other mutation or action is a
change, even one that writes nothing. So Postgres, PostHog, Pidgeon and Attio reads
count as reads only from a read-only action, and a read-only action can't reply,
send or triage through Pidgeon.

All three kinds expose `ctx.members` when `uses.members` is declared. Read
`../patchy-members/SKILL.md` for candidates, resolution, member columns and
the assignment check. Only queries track directory dependencies. Directory
reads use the platform database, outside the query's company-database snapshot.

`ctx.viewer` is never null. Owned resources act as the patch, company data as
the viewer. Server code holds no credential and has no direct network path;
reach outside systems through declared company integrations in actions.
Handler memory is not durable state, and handlers cannot schedule background work.

### Query snapshots and live access

A query with declared owned tables, file stores, shared tables or shared stores
uses one read-only `REPEATABLE READ` company transaction on one connection.
All its table and file-metadata callbacks reuse that snapshot, including shared
source data reads. A concurrent write cannot make two reads within the run disagree.
Patchy captures the commit watermark before the read. A resource-free query
uses the same fenced callback lifetime without leasing or provisioning a
company database; its watermark is empty and database-held time is zero.
The query's 3 s deadline includes any bounded connection wait; cancellation
starts at that deadline, and a guest still running at 4 s is killed.

The data snapshot does not freeze authority. `ctx.shared.<alias>` rechecks the
viewer's current access on every callback. An unshare or source access loss can
refuse a later callback even if an earlier read succeeded in the same query.
Handle that refusal rather than serving an earlier value as current data.
Member-directory reads are outside the company snapshot.

Queries have no `ctx.connections`. Company Postgres, PostHog, Pidgeon and Attio calls
belong in actions, not subscribed queries. The host enforces this kind rule, even
if code bypasses the TypeScript context. A Pidgeon send takes the draft key the
page made for that email, passed in the action's arguments; read
`../patchy-pidgeon/SKILL.md`. Attio's reads are in `../patchy-attio/SKILL.md`.

### Atomic mutations

A mutation uses one host-owned `SERIALIZABLE` company transaction. Reads see
its earlier writes, including writes to other owned tables. Patchy commits only
after validating the handler result; a throw or invalid result rolls back the
attempt. Its 5 s deadline includes connection wait, all attempts and settlement,
not 5 s per attempt. A guest still running at 6 s is killed.

On a serialization conflict, Patchy reruns the entire handler in a fresh
transaction, up to three attempts within that deadline. Treat handler memory,
time and randomness as non-authoritative. Aborted attempts leave no writes.
Repeated `write_conflict` means redesign the contended write, for example by
reducing how many rows one mutation touches. `busy` means wait for capacity,
respecting `retryAfter`; it is not a serialization conflict.

Every mutation call gets a fresh key bound to its handler, loaded version,
viewer and argument snapshot. If its outcome is unknown, use the error's
`retry()` to send that same key and arguments. A committed key returns the stored
result without running the handler again. Calling the handler afresh creates
another mutation and can duplicate a committed write. Retry within 24 hours;
an expired key is refused even after its stored result has been swept.
Check `isPatchyError(error, "unknown_outcome") && error.retry` before offering
that action. An action or tier 1 write can also have an unknown outcome, but
does not have a safe mutation retry.

### Actions and nested handlers

An action has 60 s and no transaction around its callbacks or external effects.
A guest still running at 61 s is killed. `ctx.connections.<alias>` uses the
declared integration as the viewer and rechecks access on every callback.
Each integration call has at most 15 s, or the action's remaining budget if
shorter. A disconnected connection can refuse the next call after an earlier
call succeeded.

Use typed `ctx.run.<module>.<handler>(args)` to call a sibling query or mutation
from an action. Each child has its own invocation row and parent link. A query
retains its own snapshot; a mutation owns its own transaction and host-minted
key. Its deadline is the lesser of its kind's budget and the parent's remaining
budget. The host refuses action targets. A child's key resolves its commit
uncertainty; it never makes replaying the parent action safe.

Process bulk work in bounded batches. An action is never replayed, and a failure
does not undo its completed writes. A file put followed by a table write is not
atomic. Report partial progress rather than rerunning the whole batch blindly.

`ctx.log(message, details?)` writes lines on the invocation's row, up to 32 KiB
per invocation. Exceeding it is `limit_exceeded`, not silent truncation. The log
records attribution and outcomes, not an access audit.

### Return selected files

Return a metadata entry's `handle` using `t.fileHandle()` in the result schema,
including results from nested `ctx.run` queries. The page uses
`patchy.files.url(handle)` for a frame-local blob URL,
`patchy.files.download(handle, filename?)` for a shell download, or
`useFileUrl(handle)` from `patchy/preact` for an image with `{ url, error }`.
The hook drops stale images on failure and releases its URL on unmount.

What the page sees is what handlers return. A handle freezes that selection
until the query reruns; filtering by viewer is the patch's code. Redemption
does not rerun the filter. To cut off a file when a record narrows to private,
is handed over or is deleted, re-put or delete it; handles already selected keep
redeeming until then. Already delivered bytes cannot be recalled.

The host mints deterministic 57-character handles bound to viewer, company,
consuming patch, loaded version, source store and exact object. They contain no
filename or clock and count against existing page and result limits. Publishing
preserves an eligible open version's handles. Another viewer, company, patch
or version cannot redeem them. `t.fileHandle()` belongs only in results, never
arguments or stored columns.

Every redemption needs the signed-in shell and rechecks live access.
Replacement or deletion returns `not_found`; an unshared store or lost source
access returns `access_denied`. If both happen, `not_found` takes precedence.
Redemptions are reads, not logged operations. See `../patchy-files/SKILL.md`
for URL lifetime, download offers and file limits.

### Adopt staged uploads

Declare the argument as `t.upload()`, including inside objects or arrays.
Before the handler runs, Patchy resolves the token under the initiating viewer,
consuming patch and loaded version. The handler's `upload.size` is the measured
byte length; `upload.contentType` is the stored claim, not proof of format.
An altered client size or type cannot override these values.

Validate your file rules before `await ctx.files.<store>.put(name, upload)`.
Only actions adopt, and only into a store defined by the loaded version.
Adoption consumes the Upload once and logs the existing file write as the patch.
Expired, consumed, discarded or differently bound uploads return `not_found`.
The page can discard unused stages; see `../patchy-files/SKILL.md` for the
stage/discard workflow and bounds.

Put then mutation is not atomic. A failed `ctx.run` mutation leaves the adopted
file saved. Return a business error or result that makes this partial outcome
visible, with a deliberate repair path. Never claim the file write rolled back.

## Results and failures

Declare business error codes in `errors`, then throw `new HandlerError(code,
details)`. The client exposes `isHandlerError(error, code)` for narrowing declared
codes. An undeclared code or an invalid result becomes `handler_failed`.
Patchy's refusals have `source: "patchy"`; business errors have
`source: "handler"`. Keep them separate.

Arguments are limited to 1 MiB of encoded JSON. Query and action results are
limited to 8 MiB; mutation results are limited to 64 KiB.
Oversized arguments are `too_large`; an oversized result or result-schema
violation is `handler_failed`.

The client retries a lost query reply once with the same arguments. It uses the
loaded version's served handler kind, not page-side imports or handler names.
A delivered refusal, including `unknown_outcome`, `busy`, `handler_timeout` or
a declared business error, is not a lost reply and is not retried. Actions are
never replayed.

`write_conflict` confirms that the mutation did not commit. `handler_timeout`
also requires confirmed non-commit; unresolved cancellation or commit remains
`unknown_outcome`. Closing the page does not cancel admitted work. Patchy
settles it under its original deadline and records the actual outcome.

Company call-rate admission returns `limit_exceeded`; connection or execution
capacity returns `busy`. Respect the supplied `retryAfter` before a new attempt.
Disable submit controls while a call is pending. For an action's lost reply,
inspect the resulting state before deciding which remaining steps to perform.

## Bound concurrent work

The 32 outstanding requests per frame are not a company execution allowance.
Default company bounds, counted per host replica, can refuse work earlier:

- 4 company database connections, shared by both tiers; at most 32 queued
  acquisitions wait up to 1 second within the caller's deadline, then `busy`.
- 8 actions in flight per company and 2 per viewer per patch, then `busy`.
- 2 subscription re-runs at a time per company and 2 per patch. A re-run
  holds a company connection, and one reading a shared table or store briefly
  takes a second for its access check, so re-runs can fill all 4 connections;
  none are reserved for writes.
- 100 admitted calls per second with a burst of 200, then `limit_exceeded`.

Company operating bounds may have overrides. Coalesce screen reads and use
bounded action batches rather than launching one call per card. Respect
`retryAfter`; the full registry below distinguishes contract and operating limits.

The supervisor kills a process after a 6-second event-loop stall, even inside
an action's 60-second deadline. Split synchronous work into bounded batches;
an action deadline does not grant 60 seconds of uninterrupted CPU time. A
watchdog kill is not proof of CPU abuse.

## Render from subscriptions

Call `patchy.server.<module>.<handler>(args)` for a one-shot result. For a live
screen, pass a generated query to `useQuery(handler, args)` from `patchy/preact`,
or call `.subscribe(args, onSnapshot)` and keep its returned unsubscribe function.
Mutations and actions have neither subscription API.

Both forms deliver `{ status, data, error, loading }`, with status `"loading"`,
`"ready"` or `"error"`. Render the whole `data` value and show errors separately.
An error keeps the last successful data; an initially failing query has no data.
`busy`, `rate_limited`, `source_unavailable` and `handler_timeout` back off.
A refusal inside a handler, such as an unshared source, keeps the subscription
so a reshare can recover it without a reload, even when its first run was refused.
`handler_failed`, invalid results and a removed handler end only that subscription.
Its last data and error remain visible to mounted consumers; mounting another
consumer or reconnecting does not restart it. Loss of permission to open the
document instead produces the shell's stopping notice.

Two consumers of the same handler and canonical arguments share a subscription.
Object key order does not matter; omitted fields and object fields set to
`undefined` have the same identity. Keep arguments JSON-compatible. A remount
within about one second retains the subscription. Hidden documents suspend after
30 seconds and reconcile on return; patches need no visibility timer or polling.

Patchy tracks the resources each query actually reads, including a refused
callback. Shared aliases refer to their owner's resource. Each successful run
replaces the dependency set, even if its result is unchanged; failures retain
previous and attempted dependencies until a successful run replaces them.
Read only what the screen needs to avoid wakes from unrelated resources.
Time and randomness are not dependencies. Member-directory reads are outside
the query's company-database snapshot.

After a mutation commits, Patchy announces its touched resources and returns
their revisions on the wire. Render from the subscription rather than merging
the mutation reply into a second copy of query state. Patchy owns presence and
reconciliation through the document stream; patches need no heartbeat or
presence table.

There are at most 64 subscriptions per document, 256 per patch and 1,024 per
company. The newest is refused without evicting another. Each snapshot is at
most 8 MiB; an oversized result ends only that subscription.

## The agent area

A tier 2 patch can have an agent area: its root `agent/` folder, one level deep
like `server/`. Every export of `agent/*.ts` is a tool, named after its export,
that people's own agents, such as Claude or Codex, call through Patchy MCP at
`<instance>/mcp`. Nothing else in the patch is reachable by agents, and tier 1
has no agent area. Agent tools are for agents only; the page can't call
them. Re-exporting a `server/` handler from `agent/`, as
`export { listDeals } from "../server/deals.js"`, makes it a tool too, with the
same arguments and rules; a tool of its own can take different ones. Agent
access is a company switch an admin turns on at `<instance>/company/agent-access`; a publish
with agent tools warns while it is off, and says nothing when it is on. Each
person connects their own agent with the steps at
`<instance>/machines#connect-an-agent` on Your agents, which also lists the
agents they've connected, each with Disconnect.

A tool runs as the person who connected the agent. `ctx.viewer` is that person,
under the same access rules as their page calls. `ctx.agent` is
`{ name } | null`: the client's name, a label the person approved and never
proof of who is calling. It is null for page calls, and the handlers a tool's
action reaches through `ctx.run` see the same agent. A patch can use it to hold
agents to stricter rules than people, tag the rows they write, log their calls
or refuse them. A tool of its own can require what the page leaves optional; its
schema then tells the agent, and a call missing the field is refused before the
handler runs.

To agents, a query or read-only action is a read and anything else is a change,
so Postgres, PostHog, Pidgeon and Attio reads count as reads only from a read-only action.
Clients decide whether to ask the person before a change, and most ask every
time. Patchy's log records each change and action as "Person via Client",
failures included. A query that succeeds without `ctx.log` leaves no row; a
patch that wants agent reads seen logs them itself, using `ctx.agent` for the
name.

Each export is a `query`, `mutation` or `action` from the same generated
builders as `server/`, with shared code in `helpers/`. Files only organise
tools: moving one to another file renames nothing, two files exporting one name
are refused, and adding, removing or renaming a file needs no refresh. Inside
Patchy a tool's handler is `agent.<export>`, which is how publish and logs name
it. Page imports from `agent/` are refused, and `agent/` below tier 2 is
`tier_mismatch`.

Descriptions and schemas are all an agent knows about a tool: what it does, what
it changes, and when and why it refuses. A refusal reaches the agent with its
code and details only as a `HandlerError` whose code is in `errors`; anything
else a tool throws is `handler_failed`, with its message left in the patch's
log. The ids it holds come from earlier results or from the person. The agent
reads every result in full; a row result carries `id`, `createdAt` and
`updatedAt` besides its columns. A read result over 100,000 characters is
refused, counting every row's text in full: 50 rows holding 2,000 characters of
text each reach it. A read that grows with its table, in rows or in text, needs
paging. At 300 calls a minute per person per patch, bulk work needs a tool that
takes a list.

A tool needs a `description` of at most 2,000 characters, and publish warns
about top-level arguments without `.describe()`. One patch's tools fit in
64 KiB, as agents read them with rows expanded. Tools exchange JSON only: there
are no uploads or file handles, though handlers still read the patch's own
files, and MCP can't push. `t.timestamp()` is an ISO date-time string, so an
agent must send a time of day; a plain date is a `t.text()` the handler checks.
Dev builds and publish refuse a tool that breaks these rules, naming its file;
publish lists the tools as reads and changes.

Each person has 16 calls in flight across their clients, and the first call may
wait about a second for the company's server, or up to 40 s when it is cold.
`busy` and `rate_limited` carry `retryAfterSeconds`. A change key makes a
mutation's retry write once; an action that writes is not safe to retry.

`pnpm patchy dev agent` lists the tools as an agent sees them, and
`pnpm patchy dev agent <tool> '<json>'` calls one as the dev viewer, or as the
colleague with `--colleague`; `-` reads the JSON from stdin. The call runs as an
agent's does, with `ctx.agent` `{ name: "patchy dev" }`, and dev pages show its
changes live. It answers what an agent would get, refusals exiting 2, and names
the server build that answered, saying when the latest rebuild failed and the
last good one answered instead.

<!-- generated-limits:start -->

## Limits

Contract limits are fixed for this release. Operating limits below are current defaults, not capacity promises; a company may have overrides. Handle the listed refusals. Admission is counted per host replica.

A frame may have 32 requests outstanding, but company connections and action admission can refuse earlier. Callbacks and subscription re-runs do not spend the per-viewer call rate. Calls never automatically retry busy; subscriptions back off.

PGlite dev has one connection. It does not reproduce production connection contention, serialization conflicts or containment. A watchdog kill is not proof of CPU abuse. Use bounded batches for long actions.

<!-- prettier-ignore -->
| Limit id | Kind | Default | Unit | Scope | Measures | Refusal | Company override | Configuration |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| `runtime.calls.perMinute` | contract | 300 | calls/minute | viewer | Calls per viewer per patch, excluding callbacks and subscription re-runs; patchy dev reads per person across every repo | `rate_limited` | No | release |
| `frame.outstanding` | contract | 32 | requests | viewer | Outstanding requests per document, including calls held while starting | `too_many_requests` | No | release |
| `frame.heldBytes` | contract | 67108864 | bytes | viewer | Total bytes held by one frame | `too_large` | No | release |
| `runtime.call.bytes` | contract | 65536 | bytes | viewer | Tier 1 operation envelope | `too_large` | No | release |
| `runtime.row.bytes` | contract | 1048576 | bytes | viewer | Encoded row per insert or update | `too_large` | No | release |
| `runtime.batch.bytes` | contract | 8388608 | bytes | viewer | Encoded insertMany batch | `too_large` | No | release |
| `runtime.postgres.bytes` | contract | 262144 | bytes | viewer | Postgres operation arguments | `too_large` | No | release |
| `runtime.result.bytes` | contract | 8388608 | bytes | viewer | Tier 1 operation result | `too_large` | No | release |
| `runtime.file.bytes` | contract | 20971520 | bytes | viewer | File bytes per operation | `too_large` | No | release |
| `runtime.mutation.deadline` | contract | 30000 | milliseconds | viewer | Tier 1 mutation deadline | `timeout` | No | release |
| `integration.deadline` | contract | 15000 | milliseconds | viewer | Each integration call within its parent deadline | `timeout` | No | release |
| `runtime.posthog.bytes` | contract | 262144 | bytes | viewer | PostHog operation arguments | `too_large` | No | release |
| `posthog.queries.concurrent` | contract | 3 | queries | host | Running PostHog queries per region and project in one server process, shared by every connection to that project | `busy` | No | release |
| `posthog.discovery.pages` | contract | 100 | pages | company | Definition pages one PostHog discovery reads, across events and both property kinds | None | No | release |
| `posthog.discovery.entries` | contract | 10000 | definitions | company | Event and property definitions one PostHog snapshot keeps | None | No | release |
| `posthog.discovery.bytes` | contract | 4194304 | bytes | company | Encoded PostHog snapshot | None | No | release |
| `posthog.discovery.description` | contract | 1000 | characters | company | One definition's description in a PostHog snapshot; a longer one is cut and marked [truncated] | None | No | release |
| `runtime.pidgeon.bytes` | contract | 1048576 | bytes | viewer | Pidgeon operation arguments, enough for a 100,000-character body however it encodes | `too_large` | No | release |
| `pidgeon.thread.messages` | contract | 20 | messages | viewer | Messages one page of a Pidgeon thread returns, oldest first | None | No | release |
| `pidgeon.sends.daily` | contract | 200 | sends | company | Sends and replies one Pidgeon connection attempts per UTC day, counted before Pidgeon sees each, retries and refusals included | `source_rate_limited` | No | release |
| `pidgeon.calls.concurrent` | contract | 4 | calls | host | Pidgeon calls per address at once in one server process, shared by dev and published calls; an excess call waits within its deadline | `busy` | No | release |
| `pidgeon.connect.deadline` | contract | 45000 | milliseconds | company | Connecting a Pidgeon address, changing its access or replacing its key: every call from checking the admin key to reading the snapshot | `timeout` | No | release |
| `pidgeon.snapshot.labels` | contract | 500 | labels | company | Labels one Pidgeon snapshot keeps | None | No | release |
| `pidgeon.addresses.listed` | contract | 1000 | addresses | company | Addresses the Pidgeon connect form lists from one admin key | None | No | release |
| `runtime.attio.bytes` | contract | 262144 | bytes | viewer | Attio operation arguments: filters, order and up to 500 ids | `too_large` | No | release |
| `attio.call.bytes` | contract | 16777216 | bytes | viewer | Raw Attio answers one call collects across its query and its schema and option reads together, before decoding | `too_large` | No | release |
| `attio.call.concurrent` | contract | 4 | requests | viewer | Requests one Attio call has in flight at once: its query and its schema and option reads | None | No | release |
| `attio.calls.concurrent` | contract | 4 | calls | host | Attio calls and discoveries per workspace at once in one server process, shared by every connection to it and by dev and published calls; an excess call waits within its deadline | `busy` | No | release |
| `attio.host.concurrent` | contract | 6 | calls | host | Attio calls and discoveries at once in one server process across every workspace, each held from its first request through decoding; an excess call waits within its deadline | `busy` | No | release |
| `attio.discovery.deadline` | contract | 60000 | milliseconds | company | Connecting an Attio workspace, replacing its key or refreshing it: the key check and every discovery request | `timeout` | No | release |
| `attio.discovery.requests` | contract | 3000 | requests | company | Requests one Attio discovery sends | `too_large` | No | release |
| `attio.discovery.concurrent` | contract | 8 | requests | company | Requests one Attio discovery has in flight at once | None | No | release |
| `attio.discovery.response` | contract | 2097152 | bytes | company | One raw Attio answer during discovery | `too_large` | No | release |
| `attio.discovery.bytes` | contract | 8388608 | bytes | company | Encoded Attio snapshot, checked as discovery adds to it | `too_large` | No | release |
| `attio.discovery.objects` | contract | 200 | objects | company | Objects one Attio snapshot keeps | `too_large` | No | release |
| `attio.discovery.lists` | contract | 500 | lists | company | Lists one Attio snapshot keeps | `too_large` | No | release |
| `attio.discovery.attributes` | contract | 500 | attributes | company | Attributes one Attio object or list keeps in a snapshot | `too_large` | No | release |
| `attio.discovery.options` | contract | 2000 | options | company | Active options one Attio select or status keeps in a snapshot | `too_large` | No | release |
| `attio.discovery.optionRequests` | contract | 2000 | requests | company | Requests an Attio discovery may have sent and still read options; past it, the rest are skipped and marked | None | No | release |
| `attio.discovery.optionDeadline` | contract | 45000 | milliseconds | company | Time into an Attio discovery after which it reads no more options; the rest are skipped and marked | None | No | release |
| `tier2.query.deadline` | contract | 3000 | milliseconds | viewer | Query caller deadline; read transaction cancellation starts at this deadline | `handler_timeout` | No | release |
| `tier2.mutation.deadline` | contract | 5000 | milliseconds | viewer | Mutation deadline including queue wait and all attempts; cancellation starts here | `handler_timeout` | No | release |
| `tier2.action.deadline` | contract | 60000 | milliseconds | viewer | Action caller deadline; children use the lesser of their deadline and the remaining parent budget | `handler_timeout` | No | release |
| `tier2.query.kill` | contract | 4000 | milliseconds | patch | Terminate query guest if still running, one second after caller deadline | None | No | release |
| `tier2.mutation.kill` | contract | 6000 | milliseconds | patch | Terminate mutation guest if still running, one second after caller deadline | None | No | release |
| `tier2.action.kill` | contract | 61000 | milliseconds | patch | Terminate action guest if still running, one second after caller deadline | None | No | release |
| `tier2.settlement.cleanup` | contract | 5000 | milliseconds | viewer | Settlement cleanup after deadline; unresolved connections are destroyed | `unknown_outcome` | No | release |
| `execution.stall` | contract | 6000 | milliseconds | patch | Process event-loop stall before termination | None | No | release |
| `execution.probe.interval` | operating | 250 | milliseconds | company | Supervisor health and resource sampling interval | None | Yes | deployment |
| `tier2.args.bytes` | contract | 1048576 | bytes | viewer | Encoded server.call arguments | `too_large` | No | release |
| `tier2.query.resultBytes` | contract | 8388608 | bytes | viewer | Encoded query result | `handler_failed` | No | release |
| `tier2.action.resultBytes` | contract | 8388608 | bytes | viewer | Encoded action result | `handler_failed` | No | release |
| `tier2.mutation.resultBytes` | contract | 65536 | bytes | viewer | Encoded mutation result, also the stored replay result cap | `handler_failed` | No | release |
| `tier2.callbacks.count` | contract | 1000 | callbacks | viewer | Callbacks per invocation; nested invocations count separately | `limit_exceeded` | No | release |
| `tier2.callbacks.outstanding` | contract | 8 | callbacks | viewer | Outstanding callbacks per invocation; excess work queues | None | No | release |
| `tier2.callbacks.bytes` | contract | 67108864 | bytes | viewer | Callback bytes per call tree across attempts and children | `limit_exceeded` | No | release |
| `tier2.callbacks.fileBytes` | contract | 20971520 | bytes | viewer | File bytes per callback body | `too_large` | No | release |
| `tier2.log.bytes` | contract | 32768 | bytes | viewer | ctx.log bytes per invocation | `limit_exceeded` | No | release |
| `tier2.mutation.keyLifetime` | contract | 86400000 | milliseconds | viewer | Mutation key retention and validity window | None | No | release |
| `tier2.mutation.keyFutureSkew` | contract | 300000 | milliseconds | viewer | Maximum mutation key timestamp ahead of server clock | None | No | release |
| `tier2.mutation.attempts` | contract | 3 | attempts | viewer | Maximum full handler attempts after serialization failures | `write_conflict` | No | release |
| `tier2.mutation.retryDelayMs` | operating | 100 | milliseconds | host | Base serialization retry delay; doubles per retry with jitter, inside the invocation deadline | None | No | deployment |
| `tier2.capability.tombstone` | operating | 300000 | milliseconds | host | Expired capability replay tombstone lifetime | None | No | deployment |
| `tier2.bundleCache.bytes` | operating | 67108864 | bytes | host | Verified server bundles kept in memory per host replica, least recently used evicted first; a bundle over a quarter of this is read from storage on every call | None | No | deployment |
| `tier2.bundleCache.entries` | operating | 256 | bundles | host | Server bundles kept in memory per host replica, within `tier2.bundleCache.bytes` | None | No | deployment |
| `serving.contentCache.bytes` | operating | 67108864 | bytes | host | Content URL documents kept in memory per host replica, raw, brotli and gzip bytes together, least recently used evicted first; a document over a quarter of this is read and sent uncompressed on every load | None | No | deployment |
| `serving.contentCache.entries` | operating | 256 | documents | host | Content URL documents kept in memory per host replica, within `serving.contentCache.bytes` | None | No | deployment |
| `company.connections` | operating | 4 | connections | company | Company connections per host replica | `busy` | Yes | deployment |
| `company.connections.hostBackends` | operating | 200 | connections | host | Company database connections open per host replica, working or idle; PATCHY_COMPANY_DB_MAX_BACKENDS | `busy` | No | legacy |
| `company.connections.pools` | operating | 100 | pools | host | Retained company pools per host replica | `busy` | No | legacy |
| `company.connections.waiters` | operating | 32 | waiters | company | Queued company connection acquisitions per host replica | `busy` | Yes | deployment |
| `company.connections.wait` | operating | 1000 | milliseconds | company | Maximum connection queue wait within caller deadline | `busy` | Yes | deployment |
| `subscriptions.reruns.company` | operating | 2 | runs | company | Simultaneous subscription re-runs per company per host replica, across its patches; set independently of `subscriptions.reruns.patch`. A re-run reading tables or stores holds a company connection, and one reading shared ones briefly takes a second for its access check, so re-runs can occupy every connection; none are reserved for writes | `busy` | Yes | deployment |
| `subscriptions.reruns.patch` | operating | 2 | runs | patch | Simultaneous subscription re-runs per patch per host replica, within `subscriptions.reruns.company`; an override of either leaves the other unchanged | None | Yes | deployment |
| `tier2.actions.company` | operating | 8 | actions | company | Actions in flight per company per host replica | `busy` | Yes | deployment |
| `tier2.actions.viewer` | operating | 2 | actions | viewer | Actions in flight per viewer per patch per host replica; a person's worker agent has its own, across its clients, beside their pages' | `busy` | Yes | deployment |
| `company.admission.rate` | operating | 100 | calls/second | company | Company tier 1 operations and tier 2 calls per host replica, worker agents' calls included; excludes public me, callbacks and re-runs | `limit_exceeded` | Yes | deployment |
| `company.admission.burst` | operating | 200 | calls | company | Company admission burst per host replica | `limit_exceeded` | Yes | deployment |
| `execution.management.bodyBytes` | operating | 16777216 | bytes | host | Serialized private management request, including pushed bundle source | `too_large` | No | deployment |
| `execution.process.rss` | operating | 536870912 | bytes | patch | Process RSS at termination; memory configured in MiB | None | Yes | deployment |
| `execution.breaker.kills` | operating | 3 | kills | patch | Kills across all versions of one patch within the breaker window | `patch_paused` | Yes | deployment |
| `execution.breaker.window` | operating | 600000 | milliseconds | patch | Window counting process kills; breaker is off in dev | None | Yes | deployment |
| `execution.breaker.pause` | operating | 600000 | milliseconds | patch | Pause after repeated kills; a publish clears it | `patch_paused` | Yes | deployment |
| `execution.task.cpu` | operating | 1 | vCPU | company | Company task CPU. Not read: the exec task definition sets every task's size; the id stays so existing configuration loads | None | Yes | deployment |
| `execution.task.memory` | operating | 2147483648 | bytes | company | Company task memory, 2048 MiB. Not read: the exec task definition sets every task's size; the id stays so existing configuration loads | None | Yes | deployment |
| `execution.residency.processes` | operating | 12 | processes | company | Loaded version processes; idle processes evicted first | `busy` | Yes | deployment |
| `execution.residency.bytes` | operating | 1610612736 | bytes | company | Aggregate RSS including supervisor, bundles and overlapping versions | `busy` | Yes | deployment |
| `execution.process.idle` | operating | 600000 | milliseconds | company | Ready process idle window before reap, since its last call or touch; residency still evicts idle processes first | None | Yes | deployment |
| `execution.process.load` | operating | 60000 | milliseconds | patch | Maximum unfinished initialization lifetime from spawn, even while health probes succeed | None | No | deployment |
| `execution.fleet.budget` | operating | 100 | tasks | host | Maximum live tasks across bound companies, draining tasks and spares | `busy` | No | deployment |
| `execution.housekeeping.interval` | operating | 5000 | milliseconds | host | Interval between fleet reconciliation and replenishment passes | None | No | deployment |
| `execution.housekeeping.lease` | operating | 15000 | milliseconds | host | Exclusive fleet housekeeping ownership window | None | No | deployment |
| `execution.pool.spares` | operating | 2 | tasks | host | Global spare floor; target is max(floor, wake rate times measured cold start) within fleet budget | None | No | deployment |
| `execution.pool.wakeWindow` | operating | 900000 | milliseconds | host | Observation window for company wake rate | None | No | deployment |
| `execution.pool.wait` | operating | 40000 | milliseconds | company | Empty-pool wait before start_failed, outside the handler's deadline; held calls are never replayed, and a worker agent's call is refused with 15 seconds to wait | `busy` | Yes | deployment |
| `execution.company.idle` | operating | 1800000 | milliseconds | company | Release after no active tier 2 documents and no in-flight work, from the last document letting go or page work settling; worker agents' calls never touch it | None | Yes | deployment |
| `execution.company.agentIdle` | operating | 60000 | milliseconds | company | Release after a worker agent's last call settles, nested work and cleanup included, on a clock of its own; release waits for this and execution.company.idle both | None | Yes | deployment |
| `execution.prewarm.window` | operating | 180000 | milliseconds | company | Time a member's portal view holds their company task and likeliest tier 2 versions warm before an open; a task nobody used meanwhile is released at the next pass | None | Yes | deployment |
| `execution.document.idle` | operating | 600000 | milliseconds | company | Time a connected tier 2 document goes without activity before it lets go of its company task and version process | None | Yes | deployment |
| `execution.deploy.drain` | operating | 90000 | milliseconds | host | Deployment deregistration delay | None | No | deployment |
| `execution.endpoint.lifetime` | operating | 60000 | milliseconds | host | Reuse of an ECS task's resolved address by a host of the task's release; a failed call forgets it sooner | None | No | deployment |
| `files.handle.length` | contract | 57 | characters | viewer | Fixed authorised handle size; included in page and result bounds | None | No | release |
| `files.stage.bytes` | contract | 20971520 | bytes | viewer | Bytes per staged upload | `too_large` | No | release |
| `files.stage.count` | contract | 16 | stages | viewer | Outstanding stages per viewer per patch | `limit_exceeded` | No | release |
| `files.stage.viewerBytes` | contract | 104857600 | bytes | viewer | Outstanding staged bytes per viewer per patch | `limit_exceeded` | No | release |
| `files.stage.companyBytes` | operating | 1073741824 | bytes | company | Outstanding staged bytes per company | `limit_exceeded` | Yes | deployment |
| `files.stage.lifetime` | contract | 3600000 | milliseconds | viewer | Unadopted stage lifetime before sweep | `not_found` | No | release |
| `download.bytes` | contract | 20971520 | bytes | viewer | Generated-file download encoded bytes held by shell | `too_large` | No | release |
| `csv.characters` | contract | 10000000 | characters | viewer | Decoded CSV input characters, enforced while parsing | `limit_exceeded` | No | release |
| `csv.cells` | contract | 1000000 | cells | viewer | CSV input cells, enforced while parsing | `limit_exceeded` | No | release |
| `members.page` | contract | 50 | members | viewer | Candidate list and prefix search page size | None | No | release |
| `members.getMany` | contract | 1000 | ids | viewer | Member ids per getMany call | `limit_exceeded` | No | release |
| `subscriptions.document` | contract | 64 | subscriptions | viewer | Subscriptions per document | `limit_exceeded` | No | release |
| `subscriptions.patch` | operating | 256 | subscriptions | patch | Subscriptions per patch | `limit_exceeded` | Yes | deployment |
| `subscriptions.company` | operating | 1024 | subscriptions | company | Subscriptions per company | `limit_exceeded` | Yes | deployment |
| `stream.documents` | contract | 8 | documents | viewer | Connected documents per viewer per patch | `limit_exceeded` | No | release |
| `subscriptions.snapshot.bytes` | contract | 8388608 | bytes | viewer | Snapshot result; frame held-byte cap still applies | `too_large` | No | release |
| `stream.buffer.bytes` | operating | 16777216 | bytes | viewer | Stream output buffer; slow consumers close and resume by revision | None | Yes | deployment |
| `subscriptions.deltas.buffer` | contract | 64 | deltas | viewer | Out-of-order stream deltas before resync_required | None | No | release |
| `subscriptions.deltas.gap` | contract | 5000 | milliseconds | viewer | Open sequence gap before resync_required | None | No | release |
| `subscriptions.reconcile.interval` | operating | 30000 | milliseconds | host | Reconcile durable revisions and document authority | None | No | deployment |
| `stream.hidden.suspend` | contract | 30000 | milliseconds | viewer | Hidden document delay before suspension | None | No | release |
| `stream.remount.grace` | contract | 1000 | milliseconds | viewer | Document remount grace | None | No | release |

<!-- generated-limits:end -->
