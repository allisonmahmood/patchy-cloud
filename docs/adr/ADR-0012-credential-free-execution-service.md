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

Issue #395 implements `packages/execution/engine`, `packages/execution/inspection`,
the private guest protocol in `packages/api`, and the guest entry shipped by
`patchy/server`. Runtime declares `Executor` beside `LoadedVersions`; execution
implements it, and Runtime never imports execution. `Executor` binds exact bundle
bytes to a company/patch/version and invokes admitted work. It owns no pool,
release, stop, admission or transaction settlement.

The supervisor, supervised local executor, host invocation path and fleet are
separate tickets. The decisions below constrain them; this engine does not claim
their enforcement. Tier 2 publish remains refused. There is no execution-owned
glossary: execution shares Runtime's terms.

## Engine, guest wire and inspection

Wire 1 fixes the workerd compatibility date at `2026-09-24`. This release pins
`workerd` to `1.20260924.1` and launches its platform binary directly, not the npm
Node launcher. A dynamically loaded Worker belongs to one company/patch/version;
its binding includes a verified SHA-256 of the exact bundle. Rebinding that
identity to different bytes is refused. Worker Loader caches the isolate; each
request obtains its own Worker handle because workerd handles are request-bound.

The guest has no environment bindings. Its `globalOutbound` is a refusing
loopback, including TCP connect. The guest's `ctx.props` contains its invocation
name and a callback RPC stub, never the capability or callback address. Each stub
identifies one immutable attempt dispatch. A later dispatch with the same public
identifiers cannot revive an old stub. The loader checks the deadline and liveness
before forwarding and after reading a reply, then removes the attempt on return.

The loader has explicitly configured callback service bindings, not a general
network binding. Each invocation selects its issuing host's trusted callback URL;
several host replicas may share one loaded version. Configured addresses are a
trusted caller's responsibility, not patch input. Inspection configures none.
The eventual supervisor supplies the deployment's issuing-host addresses and
owns changes to its processes and configuration.

`@patchy/api/guest` contains the private schemas, never public `HttpApi` routes.
JSON callbacks carry `{ op, args }`; both callbacks and handler replies preserve
the discriminated success, Patchy refusal and handler-error envelopes. Refusals
cross the RPC loopback as data, never thrown errors with properties that workerd
would discard. The SDK reconstructs local errors while the handler runs and
preserves the original refusal when returning it.

File callbacks carry `Uint8Array` through RPC. HTTP carries raw bytes, their media
type, and an `X-Patchy-Callback` header containing URI-encoded JSON `{ op, args }`.
A binary reply has `X-Patchy-File-Body: 1`, its media type and raw bytes. Both
byte directions enforce the shared 20 MiB file bound. The capability is only in
the loader-to-host Authorization header. Redirects are not followed.

`createGuest` captures one handler map for dispatch and descriptors. It joins
`ctx.log` callbacks before returning. Authoritative declaration checks, argument
and result validation, per-kind permission checks and settlement belong to the
host; the guest SDK is not an authorization boundary.

Inspection loads the exact bundle in a fresh throwaway workerd process, with no
company binding, callback service or Runtime dependency. It derives descriptors
under a five-second load deadline by default; a module-load throw, malformed
reply or unfinished initializer fails inspection. The scope kills and reaps the
process and removes its temporary files on success, failure or interruption.
Descriptor discovery is bundle self-description and an exact-byte consistency
check, not proof that arbitrary hostile code dispatches what it describes.

## Seven hosting decisions

1. **One company per task, then stop.** An ECS Fargate task in `us-east-1` serves
   one company and is stopped on release, never wiped and returned to the pool.
   No other company's code has run in that task's kernel. The starting task size
   is 0.5 vCPU and 2 GB. A distinct unprivileged uid per workerd process is the
   inexpensive hardening; the task remains the security boundary.
2. **A global spare pool.** The target is the larger of two spares and the wake
   rate over 15 minutes multiplied by measured cold-start time, under a fleet
   budget. An empty pool waits at most 40 seconds behind the shell's starting
   state, then returns `busy`. Residency is separate: at most 12 loaded-version
   processes and 1.5 GB aggregate, including supervisor, bundles and overlapping
   versions. Evict idle processes first; refuse `busy` if none is idle. Reap at
   60 seconds idle and kill a process at 512 MB RSS. Dormant patches spawn nothing.
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
   internet: everything it does goes through Patchy, as you, while you have the
   patch open. It reaches outside systems only through your company's
   integrations, and every write is logged for your company's admins.

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
   browser must not leave a pending row, held slot or idle transaction.
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
   settlement; per-statement SQL timeouts alone are insufficient. A query owns
   one read-only REPEATABLE READ snapshot and connection, with its commit watermark
   captured before reading and cancellation at deadline. An action's nested
   mutation owns its transaction. `ctx.run` permits sibling queries and mutations
   only, under parent/child admission accounting and the parent's remaining time.
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
connections and members with live reauthorization. Operation rows include the
invocation id. Capabilities end on return, deadline, serialization supersession
or process kill, independently of browser connection lifetime.

The host pushes bundles on `bundle_required` or process-generation change. The
task never pulls from content storage. It holds bundles, processes, the attempt
map, highest binding epoch and management secret. Callback results enter guest
memory, and globals can survive calls until process eviction or task release;
that memory is not durable or authoritative. A cache miss and zero connected
documents say nothing about whether retained version artifacts may be deleted.

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
Before loading either a bound or inspected guest, the loader parses the artifact
and rejects imports, re-exports and dynamic imports, including dormant computed
imports. This enforces the single closed-module contract rather than maintaining
a partial list of denied built-ins. Socket APIs are inaccessible through the same
boundary, and guest fetch is connected only to the refusing loopback.

Workers for Platforms is closed: it is not Patchy's backend, has one account as
the blast radius, and had no credits. Self-hosting means Patchy supplies the
operator, scheduling, wall-clock termination and memory enforcement itself.
Open-source workerd does not supply the per-invocation CPU and memory enforcement
of the managed service; we do not claim it does.
