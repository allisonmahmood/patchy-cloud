---
name: patchy-server
description: "Build tier 2 queries, mutations and actions; type helpers, handle refusals and mutation retries, and render subscribed results."
---

# Server handlers

This release defines the tier 2 contract and types. Hosted execution and tier 2
publishing are not admitted yet. These instructions describe the handler contract;
the tier 2 init ticket installs this skill when the runtime can enforce it.

## Define the contract

Export handlers from `server/<module>.ts`, one directory level deep. Each export
must be a `query`, `mutation` or `action`; its name is `<module>.<export>`.
Keep helpers in another directory. Import builders and bound context types from
`patchy/_generated/server.js`, and `t` and `HandlerError` from `patchy/server`.
Each builder takes `{ args, result, errors?, handler }`. `args` is a field map;
`result` is one descriptor. The handler receives `(ctx, args)`.

The generated builders bind the config's table types. A helper can accept
`QueryContext`, `MutationContext` or `ActionContext` without repeating generics.
A type-only import of the server modules gives the page its handler names and
arguments; renaming a handler breaks callers at compile time. Keep imports of
server code out of the page's runtime dependency graph.

Scalar descriptors are `t.text()`, `t.integer()`, `t.number()`, `t.boolean()`,
`t.timestamp()` and `t.json()`. Compose them with `t.object(fields)`,
`t.array(element)`, `t.enum(values)` and `t.nullable(value)`. `t.row("table")`
validates the full row, including its columns and system fields, not just its id.
Results are readonly.

An argument field's `.optional()` permits an omitted key. It does not permit
null; use `t.nullable(...)` for null. A table column's `.optional()` instead means
nullable. `.default()` and `t.ref()` remain table-only. `t.fileHandle()` is
results-only. `t.upload()` is allowed only in action arguments. `t.member()`
belongs to the member-directory release, not this contract.

## Choose a kind

- A query reads owned tables, file lists and metadata, and declared shared data.
  It cannot write tables or read file bytes. Reads of company Postgres are not
  subscription dependencies.
- A mutation writes owned tables inside one host-owned transaction. It has no
  shared data, connections, file-byte operations or `ctx.run`. Put external
  effects in actions. A mutation can store a file reference in a row, but a file
  write followed by a mutation is not atomic.
- An action can read and write files, reach declared connections and shared data,
  and call sibling queries and mutations through typed
  `ctx.run.<module>.<handler>(args)`. It cannot call another action this way.
  Each nested mutation has its own transaction. Split bulk work into bounded
  batches; an action has no transaction around its external effects.

`ctx.viewer` is never null. Owned resources act as the patch, company data as
the viewer. `ctx.log` contributes bounded invocation log lines. The log records
attribution and outcomes, not an access audit. Handler memory is not durable
state, and handlers cannot schedule background work.

## Results and failures

Declare business error codes in `errors`, then throw `new HandlerError(code,
details)`. The client exposes `isHandlerError(error, code)` for narrowing declared
codes. An undeclared code or an invalid result becomes `handler_failed`.
Patchy's refusals have `source: "patchy"`; business errors have
`source: "handler"`. Keep them separate.

A mutation may run up to three times inside one call after serialization
conflicts. Aborted attempts leave no writes. Exhaustion returns `write_conflict`,
which means no commit and is safe to retry. `busy` means admission or capacity
refused the call; respect its `retryAfter` rather than spinning.

An `unknown_outcome` mutation offers `retry()` using the same key and arguments.
Use that method, not a fresh call. The key makes retry safe and does not stop a
double submit; disable the button while a submit is pending. Actions are never
replayed. A timeout means confirmed non-commit; an unresolved commit remains
`unknown_outcome`. These execution and retry behaviors land with the runtime
and mutation tickets; the types reserve the contract now.

## Render from subscriptions

Call `patchy.server.<module>.<handler>(args)`. Queries also provide
`.subscribe(args, onSnapshot)` and `useQuery(handler, args)` from `patchy/preact`.
The hook returns `{ status, data, error, loading }`, with status `"loading"`,
`"ready"` or `"error"`. It retains the last data through a stream error.
Two components observing the same handler and canonical arguments share a
subscription. Omitted fields and object fields set to `undefined` have the same
identity. A short unmount/remount retains the subscription.

After a mutation, render from the subscription rather than merging the mutation
reply into a second copy of query state. Patchy owns presence and reconciliation.
The stream and hosted subscriptions are enabled by their own runtime tickets.

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
| `company.admission.rate` | operating | 100 | calls/second | company | Tier 1 operations and tier 2 calls per host replica; excludes callbacks and re-runs | `limit_exceeded` | Yes | deployment |
| `company.admission.burst` | operating | 200 | calls | company | Company admission burst per host replica | `limit_exceeded` | Yes | deployment |
| `execution.process.rss` | operating | 536870912 | bytes | patch | Process RSS at termination; memory configured in MiB | None | Yes | deployment |
| `execution.breaker.kills` | operating | 3 | kills | patch | Kills across all versions of one patch within the breaker window | `patch_paused` | Yes | deployment |
| `execution.breaker.window` | operating | 600000 | milliseconds | patch | Window counting process kills; breaker is off in dev | None | Yes | deployment |
| `execution.breaker.pause` | operating | 600000 | milliseconds | patch | Pause after repeated kills; a publish clears it | `patch_paused` | Yes | deployment |
| `execution.task.cpu` | operating | 0.5 | vCPU | company | Fargate CPU allocation | None | Yes | deployment |
| `execution.task.memory` | operating | 2147483648 | bytes | company | Fargate memory allocation, 2048 MiB | None | Yes | deployment |
| `execution.residency.processes` | operating | 12 | processes | company | Loaded version processes; idle processes evicted first | `busy` | Yes | deployment |
| `execution.residency.bytes` | operating | 1610612736 | bytes | company | Aggregate RSS including supervisor, bundles and overlapping versions | `busy` | Yes | deployment |
| `execution.process.idle` | operating | 60000 | milliseconds | company | Process idle window before reap | None | Yes | deployment |
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
