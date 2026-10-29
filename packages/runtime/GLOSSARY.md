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
The decision that a live viewer, or their worker agent while agent access is on, may start a handler on an eligible loaded version of a live company patch, within its admission limits. An agent's call starts only an agent tool, and a page's never does; an agent tool's own nested calls run ordinary sibling handlers as usual. Dispatched work retains that admission until settlement.
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
_Avoid_: correlation id, invocation id, action retry, change key (Patchy MCP's, which maps onto it)

**Action**:
A handler for work outside one transaction, including file bytes, company integrations and sibling queries or mutations. It cannot call another action, and each nested mutation owns its own transaction. A read-only action is held to reads.
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
Assigning a spare to one company, and ending that assignment after fencing admissions and draining admitted work. Release waits until no document holds the task and both the documents' idle window and the agent idle window have run out.
_Avoid_: publish, process load, connection checkout

**Agent idle**:
The minute after an agent's last call settles for which a company task stays bound when no document holds it; a person's tab holds it while they use it and for thirty minutes after, on a clock agent work never touches.
_Avoid_: keep-alive, polling window, wake (Runtime's post-commit hint)

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

**Standby process**:
A workerd an execution task starts before any version needs it, so a bind only loads its version. A bind adopts it as that version's process, with a fresh process generation; it never serves another version. The task starts a replacement once it is quiet.
_Avoid_: spare (a task, not a process), warm pool, prewarmed version

**Bind by hash**:
A version bind that names the version and its SHA-256 without the bundle. A supervisor holding a live process for it answers as a bundle bind would; one that doesn't asks for the bundle before doing anything.
_Avoid_: warm bind, touch, cached bind

**Touch**:
A management request that restarts the idle clock of a version's ready process on its company task, at the current binding epoch. It never loads, reserves or evicts: a touch that finds no process does nothing, so only a call or a warmup loads an evicted version. A host touches each version with an active tier 2 document before its idle window ends, once per version however many documents hold it, until the last one goes idle, disconnects or suspends while hidden. A paused patch's versions are not touched.
_Avoid_: heartbeat (presence is the connection), keepalive bind, bind by hash

**Warmup**:
Loading a tier 2 document's version as its first stream becomes ready, while the client boots, unless a touch finds the process loaded. A document warms once: its reconnects, reauthentications, resumes and returns from idle only touch. A prewarm warms its versions the same way.
_Avoid_: prefetch, preload (page assets)

**Prewarm**:
A signed-in member's portal view readying their company's task and the live tier 2 versions they are likeliest to open, before they open one, for `execution.prewarm.window`. It holds the task without running either idle clock, takes a spare only while another stays ready and the fleet can replace it, and keeps its versions warm as a holder that is no document. Its loads are speculative: they take only free residency slots, never evicting a process, and a demanded load evicts them first. A task claimed for a prewarm that nobody used is released as **unused**.
_Avoid_: warmup (a document's own load), preload, warm-hold (a document's holds)

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
The trusted context of one admitted operation: its company, owning patch, loaded version and manifest, initiating viewer, the worker agent it runs for if any, effective principal, wire version and correlation id.
_Avoid_: Client context, payload identity

**Effective principal**:
The identity whose authority an operation uses and whose effects it attributes. Direct browser operations use the viewer; tier 2 callbacks use the patch for its owned resources and the initiating viewer for company resources.
_Avoid_: acting identity, patch owner identity

**Owning patch**:
The patch whose loaded version defines its owned resources and declares the outside resources it can reach. Its owner never supplies the authority for a colleague's invocation.
_Avoid_: effective principal, patch owner

**Initiating viewer**:
The user whose live session, or whose agent connection, admits an invocation or a direct browser operation. A public tier 1 document has no viewer: it reaches no data.
_Avoid_: principal, machine token, owning patch

**Patch identity**:
The patch's own id, used for its owned resources. It does not inherit the owner's access and does not change on reassignment or owner deactivation.
_Avoid_: service account, owner's token

**Wire version**:
The stable deployed-bundle contract a runtime request speaks, distinct from the tooling release and the patch's schema revision.
_Avoid_: Release, schema revision, transport version

**Runtime log**:
The attributed record of mutations, integration calls, admin discovery and server invocations. Each call names the credential it came through: a viewer's session, an admin's, an agent connection, shown as the person via the client's name, or, for a dev read, a machine token, kept as its id and name at the time and with no patch or version. Mutations and actions always have invocation records; queries have them only on logging or failure. Invocation records keep the initiating viewer separate from the effective principal. A pending or unresolved outcome is not evidence that a write failed or is safe to replay.
_Avoid_: Call log (Integrations' pointer to this record), analytics event

**Request event**:
The [request event](../analytics/GLOSSARY.md) a runtime request records itself: the best-effort operational record of one runtime request, including reads and refused attempts. Its attribution is limited to the loaded version and authenticated viewer established during admission; it is not the runtime log.
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

**Active**:
A connected tier 2 document whose viewer has used it within `execution.document.idle`: its first stream, a change to its logical desired set (subscription ids, operations and canonical args) or an admitted `server.call` from its viewer for that version on that host. Reconnects, reconciliation and re-runs for other people's writes are not activity. Only an active document holds its company task and keeps its version warm; an **idle** one stays connected and ready, and its calls and live updates bind the company on demand. The host keeps each document's activity record across stream generations, and forgets a disconnected one after a bound or an hour.
_Avoid_: visible (a hidden document suspends instead), online, in use (admitted work)

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
A document's desired live result for one read and canonical argument set, bound to its patch, loaded version and initiating viewer, with separate desired and admitted states. Tier 1 subscribes to its own table reads; tier 2 subscribes to queries on its loaded version, which reach everything else.
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
Replacement of a document's desired subscriptions, with its latest vectors, after reconnect, an unrecoverable sequence gap or stalled reconciliation. It fences prior work: a read it overlaps answers it only if the revisions that read saw still match a fence taken after the replace; otherwise the subscription runs again. Equal vectors answer up-to-date without rerunning the read.
_Avoid_: reload, mutation retry
