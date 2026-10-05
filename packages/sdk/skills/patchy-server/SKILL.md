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
rows for `ctx.shared` tables and `ctx.connections`. Put invented shared files
in `fixtures/shared-<alias>/`; restart after fixture or config edits.
Read `dev.log` for each call's viewer, handler, outcome and milliseconds, `ctx.log`
output and local-only failure message/stack. Starting with `--json` records full
wide events and invocation JSON; `dev logs --json` returns `{ ok, log, text }`.
No runtime database log rows are written.

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

## Define the contract

Export handlers from `server/<module>.ts`, one directory level deep. Each export
must be a `query`, `mutation` or `action`; its name is `<module>.<export>`.
Keep reusable company code in `helpers/`, outside handler discovery. Import
builders and bound context types from `patchy/_generated/server.js`, and `t` and
`HandlerError` from `patchy/server`.
Each builder takes `{ args, result, errors?, handler }`. `args` is a field map;
`result` is one descriptor. The handler receives `(ctx, args)`.

The generated builders bind the config's table types. A helper can accept
`QueryContext`, `MutationContext` or `ActionContext` without repeating generics.
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

All three kinds expose `ctx.members` when `uses.members` is declared. Read
`../patchy-members/SKILL.md` for candidates, resolution, member columns and
the assignment check. Only queries track directory dependencies. Directory
reads use the platform database, outside the query's company-database snapshot.

`ctx.viewer` is never null. Owned resources act as the patch, company data as
the viewer. Server code holds no credential and has no direct network path;
reach outside systems through declared company integrations in actions.
Handler memory is not durable state, and handlers cannot schedule background work.

For the development-only personal-agent adapter, `ctx.viewer.agent` optionally
contains the host-established machine `{ id, name }`. `ctx.viewer.user` remains
the person whose permissions and handler rules apply. Copy both to an activity
row in the mutation transaction when the patch needs visible attribution. Browser
calls have no agent; never accept an actor or agent identity in handler arguments.
This does not enable production unattended execution.

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

Queries have no `ctx.connections`. Company Postgres reads belong in actions,
not subscribed queries. The host enforces this kind rule, even if code bypasses
the TypeScript context.

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
- At most 2 company connections for subscription re-runs and 1 re-run per patch.
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

<!-- generated-limits:start -->

## Limits

Contract limits are fixed for this release. Operating limits below are current defaults, not capacity promises; a company may have overrides. Handle the listed refusals. Admission is counted per host replica.

A frame may have 32 requests outstanding, but company connections and action admission can refuse earlier. Callbacks and subscription re-runs do not spend the per-viewer call rate. Calls never automatically retry busy; subscriptions back off.

PGlite dev has one connection. It does not reproduce production connection contention, serialization conflicts or containment. A watchdog kill is not proof of CPU abuse. Use bounded batches for long actions.

<!-- prettier-ignore -->
| Limit id | Kind | Default | Unit | Scope | Measures | Refusal | Company override | Configuration |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| `runtime.calls.perMinute` | contract | 300 | calls/minute | viewer | Calls per viewer per patch, excluding callbacks and subscription re-runs | `rate_limited` | No | release |
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
| `company.connections` | operating | 4 | connections | company | Company connections per host replica | `busy` | Yes | deployment |
| `company.connections.hostBackends` | operating | 200 | connections | host | Company database backend budget per host replica; PATCHY_COMPANY_DB_MAX_BACKENDS | `busy` | No | legacy |
| `company.connections.pools` | operating | 100 | pools | host | Retained company pools per host replica | `busy` | No | legacy |
| `company.connections.waiters` | operating | 32 | waiters | company | Queued company connection acquisitions per host replica | `busy` | Yes | deployment |
| `company.connections.wait` | operating | 1000 | milliseconds | company | Maximum connection queue wait within caller deadline | `busy` | Yes | deployment |
| `subscriptions.reruns.company` | operating | 2 | connections | company | Company connections occupied by subscription re-runs per host replica | `busy` | Yes | deployment |
| `subscriptions.reruns.patch` | operating | 1 | runs | patch | Simultaneous subscription re-runs per patch per host replica | None | Yes | deployment |
| `tier2.actions.company` | operating | 8 | actions | company | Actions in flight per company per host replica | `busy` | Yes | deployment |
| `tier2.actions.viewer` | operating | 2 | actions | viewer | Actions in flight per viewer per patch per host replica | `busy` | Yes | deployment |
| `company.admission.rate` | operating | 100 | calls/second | company | Company tier 1 operations and tier 2 calls per host replica; excludes public me, callbacks and re-runs | `limit_exceeded` | Yes | deployment |
| `company.admission.burst` | operating | 200 | calls | company | Company admission burst per host replica | `limit_exceeded` | Yes | deployment |
| `execution.management.bodyBytes` | operating | 16777216 | bytes | host | Serialized private management request, including pushed bundle source | `too_large` | No | deployment |
| `execution.process.rss` | operating | 536870912 | bytes | patch | Process RSS at termination; memory configured in MiB | None | Yes | deployment |
| `execution.breaker.kills` | operating | 3 | kills | patch | Kills across all versions of one patch within the breaker window | `patch_paused` | Yes | deployment |
| `execution.breaker.window` | operating | 600000 | milliseconds | patch | Window counting process kills; breaker is off in dev | None | Yes | deployment |
| `execution.breaker.pause` | operating | 600000 | milliseconds | patch | Pause after repeated kills; a publish clears it | `patch_paused` | Yes | deployment |
| `execution.task.cpu` | operating | 0.5 | vCPU | company | Fargate CPU allocation | None | Yes | deployment |
| `execution.task.memory` | operating | 2147483648 | bytes | company | Fargate memory allocation, 2048 MiB | None | Yes | deployment |
| `execution.residency.processes` | operating | 12 | processes | company | Loaded version processes; idle processes evicted first | `busy` | Yes | deployment |
| `execution.residency.bytes` | operating | 1610612736 | bytes | company | Aggregate RSS including supervisor, bundles and overlapping versions | `busy` | Yes | deployment |
| `execution.process.idle` | operating | 60000 | milliseconds | company | Process idle window before reap and maximum unfinished initialization lifetime | None | Yes | deployment |
| `execution.fleet.budget` | operating | 100 | tasks | host | Maximum live tasks across bound companies, draining tasks and spares | `busy` | No | deployment |
| `execution.housekeeping.interval` | operating | 5000 | milliseconds | host | Interval between fleet reconciliation and replenishment passes | None | No | deployment |
| `execution.housekeeping.lease` | operating | 15000 | milliseconds | host | Exclusive fleet housekeeping ownership window | None | No | deployment |
| `execution.pool.spares` | operating | 2 | tasks | host | Global spare floor; target is max(floor, wake rate times measured cold start) within fleet budget | None | No | deployment |
| `execution.pool.wakeWindow` | operating | 900000 | milliseconds | host | Observation window for company wake rate | None | No | deployment |
| `execution.pool.wait` | operating | 40000 | milliseconds | company | Empty-pool wait before start_failed; held calls are never replayed | `busy` | Yes | deployment |
| `execution.company.idle` | operating | 1800000 | milliseconds | company | Release after no connected tier 2 documents and no in-flight work | None | Yes | deployment |
| `execution.deploy.drain` | operating | 90000 | milliseconds | host | Deployment deregistration delay | None | No | deployment |
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
