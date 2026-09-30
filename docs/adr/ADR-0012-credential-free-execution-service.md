# ADR-0012: Handler code runs in a credential-free execution service

Handler code is hostile even when a company member publishes it. It must not run
inside the credentialed host. We use workerd's Worker Loader in a separate
execution service, with callbacks to host-owned capabilities rather than ambient
network or database access. The company task is the security boundary; separate
workerd processes provide availability isolation, not a second security claim.

This records [the execution decision](https://github.com/allisonmahmood/patchy-cloud/issues/298#issuecomment-5837397686),
its prototype and settlement addenda, and [spec #384 §§3–6](https://github.com/allisonmahmood/patchy-cloud/issues/384).
The [Fargate spike](https://github.com/allisonmahmood/patchy-cloud/issues/311#issuecomment-5836777296)
measured the engine and process cut; the
[init prototype](https://github.com/allisonmahmood/patchy-cloud/issues/314#issuecomment-5840222752)
proved bundle inspection and the guest callback path.

## Implementation boundary

The execution service is built in `packages/execution`, with engine, inspection,
supervisor, local executor and fleet entrypoints. Its guest protocol lives in
`packages/api`, and `patchy/server` ships the guest entry. Runtime declares
`Executor` beside `LoadedVersions`; execution implements it, and Runtime never
imports execution. `Executor` binds exact bundle bytes to a company/patch/version
and invokes admitted work. It owns no pool, release, stop, admission or
transaction settlement.

Runtime owns invocation admission, lifetime, capabilities, the private callback
gateway, query snapshots, mutation transactions and keys, nested calls, and
attribution records. Publishing stores both artifacts and re-derives descriptors
from stored server bytes. The cloud worktree's `pnpm dev` composes the supervised
local executor with that host path. Patch-repo `patchy dev` uses the same engine
and callback gateway over PGlite and fixtures, with atomic live server rebinding
and a separate non-admin colleague listener.

The fleet controller uses platform Postgres with either the local task provider
or the ECS provider. `EXECUTION_PROVIDER=local-fleet` launches separate supervisor
processes on an isolated development or test host. `EXECUTION_PROVIDER=ecs`
selects Fargate and is the only provider that admits production tier 2.
Local processes do not prove Fargate containment.

The ECS provider is built, but role-only Fargate acceptance remains pending the
IAM grant on [#406](https://github.com/allisonmahmood/patchy-cloud/issues/406)
and [PR #439](https://github.com/allisonmahmood/patchy-cloud/pull/439).
The measurements below came from the earlier IAM-user-credential run, not the
role-only path. Production infrastructure
[#415](https://github.com/allisonmahmood/patchy-cloud/issues/415) and first deploy
[#416](https://github.com/allisonmahmood/patchy-cloud/issues/416) remain unbuilt.

## Engine, guest wire and inspection

Wire 1 fixes the workerd compatibility date at `2026-09-24`. This release pins
`workerd` to `1.20260924.1` and launches its platform binary directly, not the npm
Node launcher. A dynamically loaded Worker belongs to one company/patch/version;
its binding includes a verified SHA-256 of the exact bundle. Rebinding that
identity to different bytes is refused. Worker Loader caches the isolate; each
request obtains its own Worker handle because workerd handles are request-bound.

The guest has no environment bindings and its `globalOutbound` is `null`.
Workerd refuses ambient fetch, WebSocket and TCP access even if a static import
check misses a socket-module import. This restriction applies to inspection and
production binding/invocation. The guest's `ctx.props` contains its invocation
name and a callback RPC stub, never the capability or callback address. Each stub
identifies one immutable attempt dispatch. A later dispatch with the same public
identifiers cannot revive an old stub. The loader checks the deadline and liveness
before forwarding and after reading a reply, then removes the attempt on return.

The loader has explicitly configured callback service bindings, not a general
network binding. Each invocation selects its issuing host's trusted callback URL;
several host replicas may share one loaded version. Configured addresses are a
trusted caller's responsibility, not patch input. Inspection configures none.
The supervisor supplies the deployment's issuing-host addresses. Each workerd
process can reach only its supervisor callback proxy, which forwards to those
addresses after checking the current epoch and live process generation.
Authenticated management binds register replacement hosts' private callback
addresses without restarting a loaded process. The proxy selects the issuing
host from the admitted invocation record, not a path or address supplied by guest
code. Registrations cannot cross a stale binding epoch.

`@patchy/api/guest` contains the private schemas, never public `HttpApi` routes.
JSON callbacks carry `{ op, args }`; both callbacks and handler replies preserve
the discriminated success, Patchy refusal and handler-error envelopes. Refusals
cross the RPC loopback as data, never thrown errors with properties that workerd
would discard. The SDK reconstructs local errors while the handler runs and
preserves the original refusal when returning it.

The loader-to-host `InvokeReply` reports an engine-owned observation separately:
`returned` with the untrusted guest reply, `deadline` when already expired before
dispatch, or `guest_failed` when execution or reply decoding fails. Late returns
retain their guest data; late throws remain execution failures. These observations
are not transaction outcomes. Only the host can classify `handler_timeout` after
confirmed non-commit or `unknown_outcome` after uncertain settlement.

Every guest reply is untrusted, including `source: "patchy"`, limit fields and
`correlationId`. The host retains each refusal's body and trusted HTTP status
and accepts a claimed platform refusal only when its body matches one of those
records, preserving the recorded status; otherwise it returns `handler_failed`.
A guest cannot designate another operation row by inventing its correlation id.
This loader-to-host envelope does not change
the guest wire stored in server bundles.

Callback deadlines return `timeout`; transport and malformed-reply failures return
`source_unavailable`, not permission denial. Ended non-expired stubs retain
`access_denied`. These callback errors promise neither non-commit nor safe retry.

File callbacks carry `Uint8Array` through RPC. HTTP carries raw bytes, their media
type, and an `X-Patchy-Callback` header containing URI-encoded JSON `{ op, args }`.
A binary reply has `X-Patchy-File-Body: 1`, its media type and raw bytes. Both
byte directions enforce `tier2.callbacks.fileBytes`, the 20 MiB per-body contract,
and refuse `too_large` with its limit id, scope and value. The capability is only
in the loader-to-host Authorization header. Redirects are not followed.

`createGuest` captures one handler map for dispatch and descriptors. It joins
`ctx.log` callbacks before returning. Authoritative declaration checks, argument
and result validation, per-kind permission checks and settlement belong to the
host; the guest SDK is not an authorization boundary.

Publication inspection loads the exact bundle in a fresh throwaway workerd
process, with no company binding, callback service or Runtime dependency.
Local dev reuses that credential-free process, but each inspection uses an
uncached, request-owned Worker. Completing the request disposes that Worker and
its background tasks; saved bundles never accumulate in the Loader's named cache.
Both paths derive descriptors under a five-second load deadline by default.
A module-load throw, malformed reply or unfinished initializer fails inspection
and reaps the process. Closing the owning scope also reaps it and removes its
temporary files.
Descriptor discovery is bundle self-description and an exact-byte consistency
check, not proof that arbitrary hostile code dispatches what it describes.

## Supervisor and local execution

`@patchy/execution/supervisor` owns one workerd process per loaded patch version.
The `apps/server/src/exec.ts` entrypoint runs it without host services or
persistence. The management listener exposes only private `POST /bind`,
`/invoke`, `/stop` and `/stats`. It authenticates before reading the body, using
the current or previous deployment secret. It binds loopback by default;
an explicit private-interface setting permits an RFC1918 or ULA address,
never a wildcard or public address. The deployment must restrict that listener
to the host security group. Invocation capabilities cannot authenticate it.

The first bind reserves the task for one company. Retrying a bundle bind at the
same epoch is idempotent while its resident process is alive. Rebinding after
reap creates a new process generation, even at the same epoch. Adoption raises
the epoch. Every management operation checks it, including report
acknowledgements. A stopped task cannot be rebound. Loading a bundle returns
its process generation, and invocation names that generation.
The callback proxy checks the immutable attempt, capability, deadline, epoch
and generation before forwarding and again before delivering a reply. It stamps
the epoch and generation on forwarded callbacks. A process kill removes its
callback routes before reaping, so late calls cannot reach the host.

The watchdog samples each process every 250 ms. It kills at the caller's
absolute deadline plus one second, after six seconds without a successful
health probe, or at 512 MiB RSS. Dispatch belongs to the supervisor's scope:
losing the management HTTP caller does not remove the running deadline.
Loading a bundle does not block the watchdog. An unfinished initializer is killed
at `execution.process.idle`, 60 seconds by default, even if health probes succeed.
Its bind fails with `load_failed`, and its process report has the same end cause.
Ready processes are reaped after 60 seconds idle. Residency allows 12 processes
and 1.5 GiB aggregate RSS, including the supervisor's retained bundles and reports.
Under memory pressure the largest idle process goes first; otherwise eviction
selects the oldest idle process. Both bind and invoke can evict idle residents;
invocation admission does not evict its target. Without an idle process to evict,
further work receives `busy` with the company scope, limiting residency id and
configured value.

Linux metering reads process CPU and RSS from `/proc`; macOS uses `ps`.
Unsupported platforms refuse supervisor construction rather than return fake
metering. An unexpected sampling failure kills only the affected resident and
records `metering_failed`; the watchdog continues supervising other residents.
When the supervisor has permission, it launches each child under a distinct
unprivileged uid and gid. An unprivileged local runner cannot grant that
separation. The company task remains the security boundary.

On reap or kill the supervisor retains one report keyed by company, patch,
version and generation, with sampled CPU seconds, peak RSS, calls served,
the end cause and all interrupted attempts. The report includes the process
wide event from spawn through end, with residency peaks over that lifetime
rather than earlier residents. `/stats` delivers reports repeatedly until
the host acknowledges their ids after durable storage. The supervisor owns no
database. A killed invocation returns `process_killed`, not a claimed rollback
or `handler_timeout`; the host must classify every attempt by its commit outcome.

`@patchy/execution/local` implements Runtime's `Executor` without a pool.
After a health kill, the host binds again to get a fresh process generation;
the executor never replays the failed invocation. Construction refuses a
production environment. The local supervisor runs in the host process, but its
aggregate residency ceiling counts only sampled supervised workerd RSS. PGlite,
fixtures, Vite and other host allocations do not consume the executor's budget.
Dedicated fleet tasks still count the supervisor, retained bundles and reports.
Both modes enforce the same workerd process count, RSS ceilings and watchdog.
Local execution proves engine compatibility and recovery, not Fargate containment
or per-invocation CPU and memory guarantees.

## Fleet controller

`@patchy/execution/fleet` is host code, not another deployed service. Its task
provider owns task launch, management transport, discovery and observed stop times.
Migration `0014_execution_fleet` owns task identity and deployment revision, company
bindings and their epochs, binding history, process reports, breaker state and the
housekeeping lease. A partial unique index permits one admission-serving binding
per company. A binding in stopping is no longer admission-serving and can never
be adopted or become a spare.
The local provider kills and reaps a process that misses its configured readiness
deadline or sends an invalid ready message; reconciliation can reclaim that slot.
Local provider instances use one private directory per platform database on the
same Linux machine. Detached task owners and OS launch locks provide shared
discovery, routing and stop records; a host's memory is not authoritative inventory.
Hosts use a common callback allowlist and stable private callback ports. Host
shutdown leaves the tasks available to another host. Explicit drain or disposable
test cleanup stops them. This local provider does not claim cross-machine discovery.

The controller records a spare claim before contacting its supervisor. An ambiguous
management acknowledgement repeats that task identity and binding epoch, never a
second spare claim. Runtime retains the exact task and epoch from admission through
all attempts, nested calls and settlement. A deployment replacement routes new work
to a fresh binding while the predecessor drains. Invocation callbacks retain the
private URL of the host that owns their capabilities and transactions.
Adoption requires the binding to have drained globally, advances its management
epoch and rebinds the same task before returning to active. A stable binding id
keeps its history and prior process reports associated across epoch changes.

Host registration does not promote a deployment. The first deployment bootstraps
after its spares are ready. For later rollouts, an operator stages a revision,
housekeeping warms its spares, and promotion selects it for new bindings only after
the capacity check passes. Existing companies move incrementally to already-ready
replacement spares; their old admissions are fenced atomically with replacement
claim, and previously admitted work drains on the predecessor. Staging and promoting
an earlier revision performs rollback. A restarting old host cannot reverse promotion.

Connected document and admitted invocation lifetimes hold shared database advisory
locks. They are not presence rows, heartbeats or a document lease. The controller
checks idle eligibility against those locks and atomically enters stopping under
the binding owner check before stopping the provider task. A disconnected document
releases its lock; an admitted call retains its separate lock through cleanup.
Each replica uses one reserved database session for these locks, not one connection
per document. A failed session is replaced and all still-held keys are reacquired,
with reference counts preserved. A bounded session probe detects loss even when
connected documents issue no requests; it does not create document presence rows.
Admission also records protection through the maximum action deadline and cleanup
bound. If the host dies and its session locks disappear, draining still waits
through that bound. Normal final settlement clears this protection.

One replica's housekeeping lease replenishes the pool, releases idle companies,
reconciles lost tasks and retires superseded deployments. The target is
`ceil(max(2, wakes / 900000 ms * measured cold-start ms))`, with every live or
draining task counted against the fleet budget. The initial budget is 100 tasks,
the pass interval five seconds and the lease fifteen seconds. These values come
from the limits registry, not another timer or counter convention.
Measured cold start spans the durable task request through readiness, including
Fargate provisioning and image pull, rather than only time since ECS `RUNNING`.
Passes serialize within a replica. A scoped renewal fiber keeps the lease alive
during provider waits, while mutation guards still fence a replica that loses it.
Reacquisition after expiry has a new lease epoch, even for the same replica.
Per-task failures are bounded and isolated, and replenishment does not depend on a
successful stats or stop call for every bound task. An empty-pool open keeps waiting
through housekeeping failures until its configured pool deadline.
An omitted ECS listing or transient `MISSING` description is not proof of exit.
Known tasks remain budgeted until the provider confirms they stopped. A running
task that reappears after a recorded stop is fenced and stopped again. If ECS
has already forgotten a task and no stop observation exists, its unresolved
reservation requires operator reconciliation rather than an inferred exit.

Process reports commit before their acknowledgement. Newly recorded process events
are forwarded unchanged through the best-effort analytics sink. Binding history
meters through the provider's stop time, including a stop discovered after its
owner died. Binding wide events retain the original bind time, spare wait, peak
processes and release cause, attributed to the emitting controller build; logging
is not the source of metering.

Three watchdog kills of a patch across versions and hosts within ten minutes pause
its admission for ten minutes. The database is authoritative on each admission.
A newer published version clears the window and pause on every host. Changing
sharing or rolling back does not. The no-pool development executor has no breaker.
Fleet operators call controller operations to release a company, drain a task,
stage or promote a deployment, retire a deployment or set a limit override.
None is a public HTTP endpoint.

Tier 2 bootstrap and resume ensure a binding before admission. The stream sends
starting, then ready, or start_failed with busy and retryAfter after forty seconds.
Pool refusals retain their effective limit id, scope and value through the stream
and broker. Breaker refusals carry the same fields on invocation admission.
The shell holds calls inside its existing bounds and keeps them across stream
loss. Failure refuses those calls once; later retries never replay them. The
selected T-1 cover appears after two seconds on both first open and resume, holds
focus under an accessible name and offers Try again after failure. Automatic retries
back off while the document remains open.

## Fargate deployment and measurements

Issue [#406](https://github.com/allisonmahmood/patchy-cloud/issues/406) runs the
same fleet controller through the ECS task provider. The image has a host default
command and a separate exec entrypoint. CI assembles it without Docker, from a
digest-pinned Node base, and compares two independently assembled archives.

Exec tasks use a private subnet with no default internet route, no public IP
and no task role. The bootstrap security group stays attached for image pulls,
logs and private host callbacks. The sealed comparison group cannot pull the
image and is not a post-start replacement. The root supervisor drops each
workerd child to a distinct uid with an empty environment. Management and
callback listeners bind the task's private address, not the ALB.
The provider rejects exec definitions without an explicit root container user;
it does not silently accept the image's default unprivileged host user.

The initial spike run used two hosts, application-cookie affinity on
`patchy_stream_affinity`, and 512-CPU-unit/2048-MiB exec tasks. First open claimed
a ready spare and reached the stream's ready frame in **685 ms**. Sixty
subscription control POSTs across two independently observed replicas had no
generation refusal. Guest fetches to both metadata addresses, the public
internet, the task's management address and management loopback all failed.
Closing the document released the idle binding and stopped its ECS task.
The acceptance overrides used a ten-second company idle window and one-second
housekeeping interval; these are not new production defaults.
On the final image, the observed task became ready 28.311 seconds after the
controller requested it. Idle detection through physical ECS stop took
49.844 seconds, including the idle window and task shutdown; a ten-second idle
window is not a ten-second physical-stop guarantee.

Adjacent host revisions served through both directions: a replacement host
invoked the old bound task, then an old host invoked the replacement task.
The original binding was durably released with cause `deployment`; the ALB
kept the old hosts through its 90-second deregistration window before they
stopped. A browser mutation was committed while its HTTP reply was deliberately
dropped. Its actual SDK error exposed `retry()`, which returned the same stored
nonce after task replacement and host drain, without reloading the document.

Secret rotation ends with a sealing revision: the same current secret, without
the previous-secret configuration, followed by promotion and another host drain.
After sealing, the retired key returned HTTP 401 on all three running exec
tasks; before sealing it authenticated to the overlap tasks. A nested action
also crossed the real private callback listener and returned the expected
viewer, company and query result. Thirty additional browser queries completed
successfully, and the original keyed retry still replayed after sealing.

Two distinct spinning version processes were measured alongside a healthy
version on one half-vCPU task. Healthy probes were dispatched at 10/s. These
are **host-observed request milliseconds**, including host/database overhead,
not isolated guest CPU time:

| Run | Baseline p50 / p95 / p99 (60 calls) | Both spin calls outstanding p50 / p95 / p99 | Outcomes                                                               |
| --- | ----------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| A   | 1266 / 1716 / 1930                  | 778 / 1020 / 1033 (50 calls)                | 50/50 healthy replies                                                  |
| B   | 1954 / 2985 / 3441                  | 724 / 1040 / 1443 (49 logged successes)     | 49/50 client requests succeeded; one non-200 response was not retained |

The spinning calls ended after 6.35/6.75 seconds in A and 6.76/6.77 seconds in B.
Their persisted process reports record `stall`, 1.37/1.45 CPU seconds in A and
1.50/1.39 in B. The short windows and differing baselines do not establish a
latency guarantee or a speed improvement. Process isolation stops the offending
processes; it does **not** reserve a sibling's share of the task's CPU.

The run was torn down after acceptance. Post-teardown checks found zero ECS
tasks or services, no run target registrations, image tags or security-group
rules, and no run platform database. ALB and target-group attributes matched
their pre-run snapshots. The script removed run artifacts and company databases,
and deregistered the run task definitions and requested their deletion.
The pre-existing tagged AWS stack and
Neon project remain available; CloudWatch run logs are retained as evidence.

The initial acceptance run passed the deployer's IAM-user credentials to hosts.
That path is removed: hosts must use the existing spike host task role.
The first role-only probe was denied `ecs:ListTasks`; an operator subsequently
granted the documented fleet policy and rotated the deployer's key, deleting the
old one. Credential-bearing host definitions were deregistered and their deletion
requested. Deleting a definition does not scrub CloudTrail history.

A role-only rerun of PR #439 at `66eb974` verified the host role through the ECS
credential endpoint, with no static AWS keys on hosts or execs. Hosts launched
warm spares and stopped idle tasks; promotion and sealing used the same role.
A fresh browser open bound an existing spare with zero spare wait and reached
ready in 481 ms. Closing the last document led to physical ECS stop in 49.244
seconds. The first two spares took 30.768 and 57.655 seconds from request to ready.
These measurements do not promise cold admission within the 40-second wait bound.

The rerun exercised both directions between adjacent deployment revisions.
It replaced binding epoch 5 with 6 and then 7, and retained the 90-second ALB drain.
The same browser document's keyed retry returned its original committed nonce after both
replacement and sealing. A role-only control task received HTTP 200 with both
management secrets during overlap; after sealing, the retired secret returned
401 and the current secret returned 200 on the active bound task.

Two repeat contention windows used action handlers so both spinning processes
remained outstanding throughout the five-second dispatch window. Healthy probes
ran at 10/s on a third version in the same half-vCPU task. These are
**client-observed milliseconds**, including browser, network, host and database
overhead, not directly comparable to the earlier host-observed measurements:

| Run | Baseline p50 / p95 / p99 (60 calls) | Two-spinner p50 / p95 / p99 (50 calls) | Healthy replies |
| --- | ----------------------------------- | -------------------------------------- | --------------- |
| A   | 632 / 999 / 1245                    | 777 / 1189 / 1300                      | 50/50           |
| B   | 638 / 768 / 928                     | 746 / 938 / 1034                       | 50/50           |

The spinning calls ended after 6.590/6.595 seconds in A and 6.756/6.862 seconds
in B. Four distinct process reports on the same task recorded `stall`, with
1.35/1.36 and 1.46/1.41 CPU seconds respectively. Healthy p95 increased in both
windows. Successful sibling replies are not evidence of unchanged sibling speed.
The role-only run was torn down and its network configuration matched the pre-run
snapshots. [Full measurements and teardown evidence are recorded on #406](https://github.com/allisonmahmood/patchy-cloud/issues/406#issuecomment-5920910104).

## Seven hosting decisions

1. **One company per task, then stop.** An ECS Fargate task in `us-east-1` serves
   one company and is stopped on release, never wiped and returned to the pool.
   No other company's code has run in that task's kernel. The starting task size
   is 0.5 vCPU and 2 GiB. A distinct unprivileged uid per workerd process is the
   inexpensive hardening; the task remains the security boundary.
2. **A global spare pool.** The target is the larger of two spares and the wake
   rate over 15 minutes multiplied by measured cold-start time, under a fleet
   budget. An empty pool waits at most 40 seconds behind the shell's starting
   state, then returns `busy`. Residency is separate: at most 12 loaded-version
   processes and 1.5 GiB aggregate, including supervisor, bundles and overlapping
   versions. Evict idle processes first; refuse `busy` if none is idle. Reap at
   60 seconds idle and kill a process at 512 MiB RSS. Dormant patches spawn nothing.
3. **Idle release counts all work.** Release follows 30 minutes with no connected
   tier 2 documents and no work in flight. Retries, nested calls after document
   departure and transaction cleanup count. Fence new admissions before stopping;
   an open racing release binds fresh. Hidden documents do not retain a task.
4. **The controller is host code over the platform database.** Atomic claims and
   a database uniqueness constraint give a company one admission-serving binding.
   Ambiguous bind acknowledgements retry by task identity and binding epoch,
   never by claiming another task. One short housekeeping lease covers spare
   replenishment, idle release, orphan reconciliation and replacing superseded
   deployments. Binding epoch, process generation, housekeeping lease and
   deployment revision are four distinct values. One image has host and exec
   entrypoints; adjacent releases interoperate during a rollout, not arbitrary
   releases.
5. **Separate management and invocation authority.** The private exec management
   listener accepts host-security-group traffic and a deployment secret, current
   or previous during rollout. The private host callback listener accepts only
   exec-security-group traffic and invocation capabilities. Nothing administrative
   is public. Fleet operations run controller code, never direct row edits.
   Extracting a deployment secret through an AWS compromise or supervisor escape
   exposes fleet-wide management authority; the design does not hide that trust.
6. **Meter from the first invocation.** Invocation records carry kind, host elapsed
   time, guest time, database-held time, callback count, argument/result bytes,
   attempts and outcome. Quiet queries use exact per-minute rollups. Nested calls
   have their own records. Inclusive elapsed time is not additive across the
   tree; callbacks, bytes and attempts are. Process records retain sampled CPU
   seconds and peak RSS on reap or kill. CPU belongs to a patch, never an
   invocation under concurrency. Binding history records bound seconds and is
   reconciled against ECS stop times. Billing decides which measurements it prices.
7. **The tier 2 promise.** A tier 2 patch's server code runs on Patchy's machines,
   never on yours. It holds no login and no credential and has no path to the
   internet: everything goes through Patchy. Own resources use the patch's
   identity; company resources and integrations use the initiating viewer's live
   authority. Every write is logged for the company's admins.

## Eight contracts

1. **Deadline, cancellation and termination are separate.** Queries have 3 seconds,
   mutations 5 and actions 60. At the absolute deadline the host fences effects
   and begins cancellation without waiting for the guest or caller. Settlement
   has a further 5-second cleanup bound. A connection whose cancellation or commit
   remains unresolved is destroyed, never pooled, and remains `unknown_outcome`
   until mutation-key reconciliation. `handler_timeout` requires confirmed
   non-commit; a late guest return cannot restore commit eligibility. The supervisor
   kills at deadline plus 1 second or a 6-second event-loop stall, probing every
   250 ms. A process kill affects all its invocations, each classified by actual
   settlement. No per-invocation CPU or memory guarantee is claimed. A dropped
   browser must not leave a held slot or idle transaction. If journal writes are
   unavailable, overdue pending records are reported as unknown, not still running.
2. **Cross-host mutation keys can race.** Duplicate-key `23505` can arise at insert
   or commit. The loser rolls back and resolves the winner's stored outcome;
   unrelated uniqueness violations never deduplicate. A `40001` instead makes
   the attempt abort-only and can re-run the whole handler, at most three attempts
   inside one call and deadline. Exhaustion is `write_conflict`, not `busy`.
3. **Stopping is atomic and owner-checked.** Transition the binding to stopping
   under its owner check in one database statement before any stop. Adoption
   cannot cross that state. Checking an epoch and later calling ECS is not a fence.
4. **Administrative authority is not an invocation capability.** A capability
   cannot invoke bind, stop, stats or fleet operations. The listeners and secrets
   remain distinct as specified above.
5. **Retained Neon connections are disposable.** An idle client failure removes
   the connection; reacquiring before work is not replaying an interrupted
   mutation. A resolved `COMMIT` on an aborted transaction is rollback, not commit.
   Track driver submission and acknowledgement; a known non-serialization commit
   rejection is confirmed rollback, not `unknown_outcome`. Use protocol
   cancellation, not `pg_cancel_backend` on a synthetic proxy pid. Provisioning
   uses SET-only grants and owner-role database drops per ADR-0009.
6. **Attempt identity never changes under a stub.** Host capabilities name
   invocation, attempt, company, patch, version, initiating viewer, kind, deadline
   and process generation. Binding epoch and process generation fence authority;
   generation alone is insufficient. Ending or superseding an attempt never
   replaces its mapping in place. Five-minute tombstones refuse replays without
   reviving references.
7. **Callback completion precedes finalization.** One host-owned fiber owns each
   mutation's SERIALIZABLE transaction. Callbacks are serialized jobs on that
   connection, with primitive savepoints, not second pool borrows. Completion
   closes admission and refuses queued jobs before its sentinel; running callbacks
   are joined or cancelled before settlement. Readiness resolves on acquisition
   failure too. The absolute deadline covers acquisition, callbacks, retry and
   settlement; per-statement SQL timeouts alone are insufficient. A query with
   owned tables, file stores or shared-table/shared-store declarations owns one read-only
   REPEATABLE READ snapshot and connection, with its commit watermark captured
   before reading and cancellation at deadline. A resource-free query retains
   the same fenced, serialized callback lifetime, but needs no company database
   lease: its watermark is empty and its database-held time is zero. The snapshot
   never freezes shared-resource authority; callbacks still check live access.
   An action's nested mutation owns its transaction. `ctx.run` permits sibling
   queries and mutations only, under parent/child admission accounting and the
   parent's remaining time.
   Result validation precedes commit. The transaction owner announces touched
   resources only after commit, preserving durable subscription truth.
8. **Rollouts fence, then drain.** Fence old admissions, bind fresh, route new
   invocations, then stop the predecessor after drain. The 90-second deregistration
   delay exceeds the action deadline. The document sees ordinary EOF, reconnect,
   resync and keyed retry; seamless handover is not promised.

## Callback authority and retained memory

The host mints an opaque per-attempt capability resolvable only by its issuing
replica. Callbacks return to that replica's private address, which owns any held
transaction. The gateway resolves the effective principal on every callback:
the patch for its own resources, the initiating viewer for shared resources,
connections and members with live reauthorization. Production trusts the admitted
JWT until its `exp`. At expiry, callbacks share one lazy backend check of the
admitted Clerk session id and subject for the rest of that invocation, including
concurrent callers and failed results. The cache does not cross invocations.
Clerk revocation after that check is observed by a later invocation, not by
polling every callback. Every authorized callback still reloads current database
membership, role and deactivation and refuses a changed user or company. No
session credential enters the guest. Operation rows include the invocation id.
Capabilities end on return,
deadline, serialization supersession or process kill, independently of browser
connection lifetime.

`Runtime` admits `server.call` through the same live-session and loaded-version
door as browser operations, then hands the call to `Invocation`. It validates
arguments against the loaded version's descriptors, loads exact retained bytes
through `ServerBundles`, and binds and invokes `Executor`. Action slots are
counted per host, eight per company and two per viewer per patch by default,
including calls whose HTTP waiter has disconnected. A tier 2 document's direct
name-based table, file, shared-resource, member and connection calls are refused
even after a rollback serves tier 1. Conversely, while tier 2 is served, an older
tier 1 document can call only `me`. Public documents cannot call handlers.
An unwired invocation seam returns `source_unavailable` (503), not a malformed
request refusal.

`InvocationCapabilities` assigns a fresh opaque token to every immutable attempt.
The token is local to one host replica and binds its company, patch, version,
viewer, kind, deadline and process generation. Ended capabilities retain only
attempt identity and refusal reason for the five-minute replay window; they do
not retain session resolvers or callback results after settlement.
`CallbackGatewayApi.listen` starts a separate `/callback` listener on loopback,
or on an explicitly permitted private literal address. It is never mounted on
the public API. Deployment must restrict that listener to the execution security
group. The gateway authenticates the capability and immutable attempt headers
before reading the body. Authenticated attempts spend the callback allowance even
when their body is malformed or too large. It queues above eight outstanding
callbacks and accounts streamed request bytes and replies against the shared
call-tree budget. Mutation and integration callbacks require `RuntimeLog`; a
missing logging layer cannot silently disable attribution.

The invocation owner runs in the host service scope, independently of its HTTP
waiter. Its absolute deadline fences the capability and starts cancellation even
when the executor never returns. Pre-dispatch journal insertion shares that
deadline: the executor never runs before its required row is confirmed. Final
journal writes share the absolute deadline plus cleanup bound. Waiting on a
detached journal fiber cannot let blocked SQL cancellation hold the owner or its
action slot. Overdue pending journal rows read as `unknown_outcome` (invocations)
or `unknown` (operations); stored evidence is retained for later reconciliation.

Resource owners register cancellation, a settled signal and synchronous
destruction through `InvocationCapabilities.retain`. Settlement waits at most
five seconds for callbacks and registered resources. An unresolved resource is
destroyed, never pooled. An abnormal action fence after a mutation or integration
callback started can remain `unknown_outcome`, even if an earlier autocommit
completed. Interrupting a callback fiber is not proof of non-commit.
Mutation transactions instead classify their own acknowledged commit or rollback
and resolve uncertain commits by mutation key. Queries and mutations attach
their connections to this retained-resource lifetime.

`runtime_invocations` records actions and mutations before dispatch. Top-level
queries create a row only on a log line, business refusal or failure. Nested
queries and mutations always have a row with their action's invocation id as `parent_id`.
Callback writes and integration calls retain their operation rows, with `invocation_id` and
`effective_principal`; own-resource rows have null `user_id` and principal
`patch`. Invocation rows keep the initiating viewer separately. Declared
`HandlerError` codes have outcome `handler_error`; undeclared codes, invalid
results and forged platform refusals become `handler_failed` with a host
correlation id. SDK exception messages and stacks go through the bounded private
log callback, never the browser reply. Quiet query runs meter into exact
per-minute rollups independently of reply delivery.

The host pushes bundles on `bundle_required` or process-generation change. The
task never pulls from content storage. It holds bundles, processes, the attempt
map, highest binding epoch and management secret. Callback results enter guest
memory, and globals can survive calls until process eviction or task release;
that memory is not durable or authoritative. A cache miss and zero connected
documents say nothing about whether retained version artifacts may be deleted.

## Query snapshots and action callbacks

A query with declared company resources uses one retained company connection
and one read-only `REPEATABLE READ` transaction across its callbacks. A
resource-free query retains the same fenced callback lifetime without a company
lease, with an empty watermark and zero database-held time.
Acquisition uses the bounded company wait and
consumes the query's three-second deadline. Before callback reads, the host captures
the declared resources' revision vector as its commit watermark, including canonical
shared-table and shared-store owners. Callback jobs run serially on that snapshot;
owned tables, shared-table rows and file metadata cannot drift between callbacks.
`ctx.files` exposes list and stat metadata with authorised file handles, but no
file bytes in a query. Handlers choose which handles to return to the page.
Declared member-directory reads use the platform database, not this company
snapshot.

Shared authority is not snapshot data. Each callback checks the viewer, the source
patch's current liveness, and current inventory sharing before reading snapshot rows.
Queries declaring shared tables or shared stores leave headroom within the configured company pool
for a fresh, bounded authority checkout. No extra connection bypasses that pool's
limit. With a one-connection pool, shared queries return `busy`; own-resource queries
can still run. Local PGlite uses fixed fixture authority, not simulated unsharing.

Return rolls back the read-only transaction and releases the connection. At the
query deadline, capability fencing starts protocol cancellation independently of
the HTTP caller; the supervisor terminates the guest at four seconds if necessary.
The host returns `handler_timeout` only after cleanup confirms the read transaction
ended. Unresolved cleanup destroys the connection rather than returning it to the
pool. The retained resource measures database-held milliseconds for invocation rows.

Actions have no surrounding transaction. Their deadline is sixty seconds, with
termination one second later. Each declared integration call rechecks access as the
viewer and gets at most fifteen seconds or the action's remaining budget, whichever
is less. File put accepts plain bytes or adopts a staged Upload; get and delete
retain the existing file operation semantics. Adoption commits the file pointer
and consumes the stage atomically, but a following mutation is a separate
transaction. A failed follow-up mutation leaves the file intact.

`ctx.run` admits sibling queries and mutations under the action's existing
admission, exact bundle and process generation. Each child has its own invocation
id, capability, resource and row. Its deadline is the lesser of its kind's budget
and the parent's remaining time. Children share the call-tree byte allowance,
not log allowances. The host refuses action targets. A nested mutation has a
host-minted key to resolve its commit uncertainty, never to replay its parent.
Its held-connection time contributes to both its own and the action's `db_ms`.

Arguments are at most one MiB. Query and action results are at most eight MiB;
invalid result schemas are `handler_failed`. Each invocation has a thirty-two KiB
log allowance. The client retries a lost query reply once using handler kinds from
the loaded shell's bootstrap. Unknown kinds and actions are never replayed.

## Mutation transactions and keys

Runtime owns the invocation's SERIALIZABLE transaction and serial callback jobs.
Primitives adapts its database port to the company lease. The first database
callback opens the transaction; a callback-free mutation opens one to persist its
key and result. Table operations reuse that connection and keep their savepoints.
The pool still defaults to four connections. A mutation holds one slot until
commit, confirmed rollback or destruction, not one slot per callback.

Handler completion closes callback admission and refuses queued jobs before
finalization. Only a validated result may commit. A `40001` marks the attempt
abort-only even if guest code catches the callback failure. Runtime rolls back,
fences the old capability, and re-invokes the complete handler with a fresh
attempt, at most three times. Retries wait with jitter after rollback, without
holding a connection; the base delay comes from the operating registry. The
original five-second deadline covers queue wait, acquisition, all attempts and
settlement. Exhaustion is `write_conflict`, which proves non-commit and carries
the enforced `tier2.mutation.attempts` limit, scope and value; attempts also appear
in the request's limit peaks. Pool contention is `busy`.

Each attempt sets database timeouts from its remaining budget. Commit submission
and acknowledgement are distinct states. A known commit rejection is rollback;
a resolved `COMMIT` whose command tag says `ROLLBACK` is also rollback.
`handler_timeout` requires confirmed non-commit. Unresolved cancellation or commit
at the cleanup bound destroys the session and remains `unknown_outcome` until
key reconciliation supplies evidence.
The owner retains the committed reply as soon as the driver acknowledges it.
That local proof wins over a later deadline or failed key lookup. Wake delivery
starts after the company lease is released, independently of the reply, and is
bounded by the remaining cleanup allowance. A slow wake cannot consume a company
slot or turn committed success into a timeout; durable reconciliation covers a
missed wake.

The company inventory upgrade creates the mutation-key store idempotently.
The key, owning patch, handler, loaded version, initiating viewer, originating
invocation id, argument fingerprint, result and written revisions commit together.
Only the transaction owner announces touched resources after that commit. A replay
returns the stored result and revisions. Stored commit evidence also reconciles
the originating invocation's unresolved outcome without replacing its metering
or reply-delivery record. A duplicate-key `23505` at insert or commit rolls back the
loser before reading the winner; another constraint's uniqueness error is not a
mutation-key race.

The client mints `<ms>-<128 random bits, base64url>` from the stream's server
clock. A key expires after 24 hours even if its stored row survives; keys more
than five minutes in the future are refused. A changed binding or argument
fingerprint is refused rather than executed afresh. Stored rows are swept after
24 hours. An in-window key without a visible committed result may execute;
the key constraint settles concurrent attempts across hosts.

A lost mutation reply becomes `unknown_outcome` with an explicit `retry()` that
preserves the key and captured arguments. It can recover a committed result
without duplicate writes. A new handler call mints a new key. Neither mutation
transport loss nor action transport loss causes automatic replay.

## Server runtime promise

Supported APIs have release tests against the pinned workerd: `Intl.NumberFormat`
including exact decimal-string formatting, `DateTimeFormat`, `PluralRules`,
`RelativeTimeFormat`, `ListFormat`, `Collator`, `DisplayNames` and `Segmenter`;
Web Crypto `randomUUID`, `getRandomValues` and `subtle`; `TextEncoder`,
`TextDecoder`, `structuredClone`, `URL`, `URLSearchParams`, `atob`, `btoa` and
`BigInt`. Fetch and sockets, Node globals and built-in imports, `eval` and
`new Function` are refused deliberately. Everything else, including Temporal if
present, is incidental and unsupported rather than forbidden.

The engine explicitly disables both `nodejs_compat` and `nodejs_compat_v2`; the
pinned compatibility date would otherwise enable them by default. This is not
alone an import boundary: workerd still exposes a minimal `node:process` module.
Before loading either a bound or inspected guest, the loader scans the artifact
for imports, re-exports and dynamic imports to give an early closed-module error.
This lexer is not a containment boundary. In particular, JavaScript's ambiguous
division/regular-expression syntax can hide an import from it. Loaded Workers
receive no ambient network capability regardless of that result. Regressions
execute an unparenthesized `function(){} / import("cloudflare:sockets") / 1`
bypass against real TCP, fetch and WebSocket listeners while preserving trusted
callback RPC.

Workers for Platforms is closed: it is not Patchy's backend, has one account as
the blast radius, and had no credits. Self-hosting means Patchy supplies the
operator, scheduling, wall-clock termination and memory enforcement itself.
Open-source workerd does not supply the per-invocation CPU and memory enforcement
of the managed service; we do not claim it does.
