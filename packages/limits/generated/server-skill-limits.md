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
| `execution.task.cpu` | operating | 0.5 | vCPU | company | Fargate CPU allocation | None | Yes | deployment |
| `execution.task.memory` | operating | 2147483648 | bytes | company | Fargate memory allocation, 2048 MiB | None | Yes | deployment |
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
