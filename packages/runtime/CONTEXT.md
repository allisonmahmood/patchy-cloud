# Runtime

Runtime binds a loaded patch's operations and handler invocations to its version and initiating viewer. It chooses the effective principal without handing patch code a credential. The execution package shares this glossary.

## Language

**Operation**:
One named request a patch makes through Patchy, with its own input and result contract. An operation is a read, a mutation, or an integration call.
_Avoid_: endpoint (the transport, not the operation), arbitrary request

**Handler**:
A named query, mutation or action in a patch's server code, with declared arguments, result and optional business error codes.
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
A handler for work outside one transaction, including file bytes, company integrations and sibling queries or mutations.
_Avoid_: background job, transaction

**Execution service**:
The credential-free side of the deployment that runs handler code and reaches Patchy only through callbacks.
_Avoid_: sandbox (the browser's), worker (an engine term), lambda

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
The page's typed view of its server handlers, derived from their exports so changes to names and signatures reach callers.
_Avoid_: server bundle, handwritten API wrapper

**Binding**:
The trusted context of one admitted operation: its company, owning patch, loaded version and manifest, initiating viewer, effective principal, wire version and correlation id.
_Avoid_: Client context, payload identity

**Effective principal**:
The identity whose authority a callback uses and whose effects it attributes: the patch for its own resources, the initiating viewer for company resources.
_Avoid_: acting identity, patch owner identity

**Owning patch**:
The patch whose loaded version defines its owned resources and declares the outside resources it can reach. Its owner never supplies the authority for a colleague's invocation.
_Avoid_: effective principal, patch owner

**Initiating viewer**:
The user whose live session admits an invocation or a direct browser operation. A public document has no initiating viewer with company authority.
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
The best-effort operational record of one runtime request, including reads and refused attempts. Its attribution is limited to the loaded version and authenticated viewer established during admission; it is not the runtime log.
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
The connection carrying a company document's lifecycle and subscription frames from Patchy. A document has at most one connected stream; reconnecting replaces its generation without changing its loaded version.
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
A document's desired live result for one read and canonical argument set. Tier 1 supports owned and declared shared-table `list` and `get`; writes and reconnects trigger reconciliation, not replay of mutations.
_Avoid_: stream, polling loop

**Revision**:
A durable monotonic counter committed with a resource write or patch lifecycle change. Resource keys are `table:<patchId>:<name>`, `store:<patchId>:<name>` and `patch:<patchId>`; vectors encode counters as decimal strings and absence as `"-1"`.
_Avoid_: version (a published bundle), timestamp

**Wake**:
A best-effort post-commit hint naming changed dependency keys, delivered locally and across hosts. It carries no rows or file bytes; durable revisions and periodic reconciliation recover lost hints.
_Avoid_: snapshot, durable event

**Snapshot**:
A subscription's whole read result with the dependency revisions observed by that read. A missing `get` is a result and still depends on its table.
_Avoid_: row diff, cached response

**Dependency set**:
The resource and source-patch keys a subscription has observed, including keys recorded before a read is refused. Keeping refused dependencies lets reshare and restore recover the subscription.
_Avoid_: declared resources (the permitted capabilities), row locks

**Fence**:
The revision vector a subscription must reach for its current desired-set sequence before reconnect catch-up is complete. Reopening the stream alone does not satisfy it.
_Avoid_: stream generation (connection identity), publish version

**Resync**:
Replacement of a document's desired subscriptions, with its latest vectors, after reconnect or an unrecoverable sequence gap. It fences prior work; equal vectors answer up-to-date without rerunning the read.
_Avoid_: reload, mutation retry
