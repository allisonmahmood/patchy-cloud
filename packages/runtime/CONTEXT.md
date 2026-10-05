# Runtime

Runtime binds a loaded patch's operations and handler invocations to its version and initiating viewer. It chooses the effective principal without handing patch code a credential. The execution package shares this glossary.

## Language

**Operation**:
One named request a patch makes through Patchy, with its own input and result contract. Direct resource operations and handler calls are distinct operations; a handler can make several resource callbacks.
_Avoid_: endpoint (the transport, not the operation), arbitrary request

**Handler**:
A query, mutation or action exported by a patch's server code, named by its module and export. Its descriptor declares arguments, result and optional business error codes.
_Avoid_: endpoint, function route

**Invocation**:
One admitted call to a server handler, including its attempts, callbacks and settlement. Its lifetime continues after the initiating document disconnects.
_Avoid_: HTTP request, process, callback

**Patch tier**:
The tier of the version a patch currently serves, distinct from the tier of a document's loaded version.
_Avoid_: declared tier, loaded tier

**Server required**:
The refusal of a direct operation when a tier 2 document must use handlers, or when a lower-tier document belongs to a patch currently serving tier 2. The latter keeps only its identity read until the patch serves a lower tier again.
_Avoid_: revoked, permission lost

**Invocation admission**:
The decision that a live viewer may start a handler on an eligible loaded version of a live company patch, within its admission limits. Dispatched work retains that admission until settlement.
_Avoid_: callback authorisation, presence lease

**Agent grant**:
Patch-owned authority for one personal-agent machine credential to call one
live company Tier 2 patch through the development adapter. Patches stores grants
and the current policy; Runtime reads them at admission and callback boundaries.
The grant has no mode snapshot and follows access changes. Removing it refuses
new calls and later callbacks. Production external execution remains unavailable.

**Agent attribution**:
The host-established machine id and name accompanying the initiating person.
Handlers receive optional `ctx.viewer.agent`; invocation records retain its
snapshot even if the machine is later revoked. Ordinary browser calls have none.
_Avoid_: caller-supplied actor, cryptographic signature, patch identity

**Callback authorisation**:
The decision about one operation requested by an invocation. Owned resources inherit invocation admission; company resources require the initiating viewer's current authority.
_Avoid_: invocation admission, guest permission

**Query**:
A read-only handler whose result can be subscribed to as its viewer.
_Avoid_: SQL query, polling function

**Mutation**:
A handler whose owned-table writes and validated result settle in one transaction; a failed attempt leaves no writes.
_Avoid_: action, individual row write

**Mutation key**:
The identity of one mutation call, bound to its handler, loaded version, initiating viewer and arguments. Retrying that call preserves its key so a committed result can be recovered without applying its writes twice.
_Avoid_: correlation id, invocation id, action retry

**Action**:
A handler for work outside one transaction, including file bytes, company integrations and sibling queries or mutations. It cannot call another action, and each nested mutation owns its own transaction.
_Avoid_: background job, transaction

**Execution service**:
The credential-free side of the deployment that runs handler code and reaches Patchy only through callbacks.
_Avoid_: sandbox (the browser's), worker (an engine term), lambda

**Company task**:
A company-exclusive execution task that hosts its loaded patch versions. Release stops it; another company never inherits it.
_Avoid_: patch instance, reusable worker

**Spare**:
An execution task that has never been bound to a company and is available for a first bind.
_Avoid_: idle company task, recycled task

**Bind / release**:
Assigning a spare to one company, and ending that assignment after fencing admissions and draining admitted work.
_Avoid_: publish, process load, connection checkout

**Housekeeping lease**:
The temporary exclusive authority for one host replica to maintain the execution fleet.
_Avoid_: document presence, binding epoch, process generation

**Fleet promotion**:
Selecting a prepared deployment revision for new company bindings and gradual replacement of existing tasks. An earlier revision can be promoted again for rollback.
_Avoid_: host startup, patch publish

**Stopping**:
A binding whose admissions are fenced while admitted work drains and its task is stopped. It cannot be adopted or return to serving.
_Avoid_: idle, spare, stopped

**Paused**:
A temporary patch-wide admission refusal after repeated process kills, across all its versions. Expiry or a new publish clears it.
_Avoid_: retired, revoked, disabled

**Supervisor**:
The execution service's process owner. It loads patch versions, watches their processes and terminates or reaps them without deciding invocation commit outcomes.
_Avoid_: fleet controller, handler, security boundary

**Process generation**:
The identity of one loaded version's process lifetime. A replacement process gets a new generation; a call from the previous generation has no authority.
_Avoid_: version id, binding epoch, stream generation

**Binding epoch**:
The increasing authority number for a company's execution-task binding. Adoption advances it and fences management calls from the previous owner.
_Avoid_: process generation, deployment revision, housekeeping lease

**Invocation capability**:
The opaque per-attempt reference the execution service presents on callbacks, never seen by handler code.
_Avoid_: API key, session token

**Callback gateway**:
The host's private entry for execution-service callbacks, admitted by invocation capability and checked under the effective principal for each operation. It grants no execution-management authority.
_Avoid_: broker (the browser's), proxy, management listener

**Inspection**:
Loading a server bundle without invocation authority to derive its handler descriptors before admission.
_Avoid_: handler execution, independent proof, build

**Context object**:
The viewer and capabilities supplied to a handler, narrowed to its kind and declared resources.
_Avoid_: binding, application state

**Handler error**:
A declared business refusal from patch code, distinct from a Patchy refusal or an unhandled handler failure.
_Avoid_: runtime failure, transport error

**Generated client**:
The tier 2 page's typed view of its server handlers, derived from their exports so changes to names and signatures reach callers. It offers handler calls and query subscriptions alongside the shell capabilities, never direct name-based resource operations.
_Avoid_: server bundle, handwritten API wrapper

**Binding**:
The trusted context of one admitted operation: its company, owning patch, loaded version and manifest, initiating viewer, effective principal, wire version and correlation id.
_Avoid_: Client context, payload identity

**Effective principal**:
The identity whose authority an operation uses and whose effects it attributes. Direct browser operations use the viewer; tier 2 callbacks use the patch for its owned resources and the initiating viewer for company resources.
_Avoid_: acting identity, patch owner identity

**Owning patch**:
The patch whose loaded version defines its owned resources and declares the outside resources it can reach. Its owner never supplies the authority for a colleague's invocation.
_Avoid_: effective principal, patch owner

**Initiating viewer**:
The user whose live session admits an invocation or a direct browser operation. On a public tier 1 document, only declared member-directory reads can use an authenticated company viewer's authority.
_Avoid_: principal, machine token, owning patch

**Patch identity**:
The patch's own id, used for its owned resources. It does not inherit the owner's access and does not change on reassignment or owner deactivation.
_Avoid_: service account, owner's token

**Wire version**:
The stable deployed-bundle contract a runtime request speaks, distinct from the tooling release and the patch's schema revision.
_Avoid_: Release, schema revision, transport version

**Runtime log**:
The attributed record of mutations, integration calls, admin discovery and server invocations. Mutations and actions always have invocation records; queries have them only on logging or failure. Invocation records keep the initiating viewer separate from the effective principal. A pending or unresolved outcome is not evidence that a write failed or is safe to replay.
_Avoid_: Call log (Integrations' pointer to this record), analytics event

**Request event**:
The [request event](../analytics/CONTEXT.md) a runtime request records itself: the best-effort operational record of one runtime request, including reads and refused attempts. Its attribution is limited to the loaded version and authenticated viewer established during admission; it is not the runtime log.
_Avoid_: Audit record, runtime-log entry

**Invocation metering**:
The unsampled settlement record of guest time, company-connection-held time, callbacks, argument and result bytes, attempts and outcome. Host elapsed time and guest time are inclusive, not tree totals. A parent action's database time includes its nested calls; connection queue wait is excluded.
_Avoid_: request event, billing charge

**Query rollup**:
The exact totals for quiet top-level query runs by company, patch, version, handler and UTC start minute. Settlement commits the increment and its deduplicating run id together; ids expire after one hour. Logged, failed and nested queries have invocation rows instead. A client retry has a new run id.
_Avoid_: sample, runtime log, request event

**Correlation id**:
The identifier joining an operation's failure to its runtime-log record. It is created by Patchy, never supplied by patch code.
_Avoid_: Publish key, patch id

**Stream**:
The connection carrying an authenticated document's lifecycle and subscription frames from Patchy. A document has at most one connected stream; reconnecting replaces its generation without changing its loaded version.
_Avoid_: session, subscription (a query's desired live result)

**Document**:
One shell document bound to a loaded patch version. It outlives its connection, including a hidden period.
_Avoid_: tab, session, viewer (one person may hold several documents)

**Connected**:
A document whose stream is open. Presence is derived from that connection, not a lease or stored row.
_Avoid_: online, alive, heartbeat

**Lifecycle frame**:
A stream message about a document's version or authority, not its data.
_Avoid_: wake (a resource changed), notification

**Superseded**:
A loaded version that is no longer served but remains eligible. The document keeps it until reload or close.
_Avoid_: revoked, stale, outdated

**Eligible version**:
A retained version of a live, enabled patch that the viewer may open. Superseding a version does not make it ineligible. Version revocation policy is undecided in [#425](https://github.com/allisonmahmood/patchy-cloud/issues/425); the `revoked` frame is reserved, with no revocation state or operation today.
_Avoid_: current (the served version), live (the patch's state)

**Stream generation**:
The identity of one admitted connection. A replacement fences requests naming the previous generation.
_Avoid_: document id, wire version

**Subscription**:
A document's desired live result for one read and canonical argument set, bound to its patch, loaded version and initiating viewer, with separate desired and admitted states. Tier 1 subscribes to owned or shared table reads and declared member-directory reads; tier 2 subscribes to queries on its loaded version.
_Avoid_: stream, polling loop

**Revision**:
A durable monotonic counter committed with a table, file store or member-directory change, or with a patch lifecycle change. Subscription vectors include the resources read and the lifecycle revisions of shared sources; a revision is evidence of change, not proof that a result is current.
_Avoid_: version (a published bundle), timestamp

**Wake**:
A best-effort post-commit hint naming changed dependency keys, delivered locally and across hosts. It carries no rows or file bytes; durable revisions and periodic reconciliation recover lost hints.
_Avoid_: snapshot, durable event

**Snapshot**:
A subscription's whole read result with the dependency revisions observed by that read. A missing `get` is a result and still depends on its table.
_Avoid_: row diff, cached response

**Dependency set**:
The canonical owner resources observed by a subscription's host, including attempts refused for access. Successful runs replace this set even when their result is unchanged; failed runs retain previous and attempted resources. A wake received during a run applies to the resulting set.
_Avoid_: declared resources (the permitted capabilities), row locks

**Recoverable refusal**:
A handler's business error or a refused callback that leaves its subscription eligible to run again when its sources change. Its last value remains available. This differs from losing document authority, which stops the document.
_Avoid_: permanent failure, successful snapshot

**Permanent subscription failure**:
A handler failure, invalid result or missing handler in the loaded version that ends one subscription while preserving its last value. Other subscriptions on the document continue.
_Avoid_: served-version change, document revocation

**Fence**:
The revision vector a subscription must reach for its current desired-set sequence before reconnect catch-up is complete. Reopening the stream alone does not satisfy it.
_Avoid_: stream generation (connection identity), publish version

**Resync**:
Replacement of a document's desired subscriptions, with its latest vectors, after reconnect or an unrecoverable sequence gap. It fences prior work; equal vectors answer up-to-date without rerunning the read.
_Avoid_: reload, mutation retry
