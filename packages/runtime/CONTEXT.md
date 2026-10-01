# Runtime

Runtime is the path by which a loaded patch asks Patchy to act as its viewer. It binds each operation to the loaded version and the viewer, without handing the patch a credential.

## Language

**Operation**:
One named request a patch makes through Patchy, with its own input and result contract. An operation is a read, a mutation, or an integration call.
_Avoid_: endpoint (the transport, not the operation), arbitrary request

**Handler**:
A named query, mutation or action in a patch's server code, with declared arguments, result and optional business error codes.
_Avoid_: endpoint, function route

**Query**:
A read-only handler whose result can be subscribed to as its viewer.
_Avoid_: SQL query, polling function

**Mutation**:
A handler whose owned-table writes and validated result settle in one transaction; a failed attempt leaves no writes.
_Avoid_: action, individual row write

**Action**:
A handler for work outside one transaction, including file bytes, company integrations and sibling queries or mutations.
_Avoid_: background job, transaction

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
The trusted context of one admitted operation: its company, owning patch, loaded version and manifest, acting principal, wire version and correlation id.
_Avoid_: Client context, payload identity

**Acting identity**:
The viewer whose authority an operation uses and whose actions it attributes. This is distinct from the owning patch and its owner.
_Avoid_: Patch owner identity

**Owning patch**:
The patch whose loaded version defines its owned resources and declares the outside resources it can reach. Ownership of a patch never makes its owner the acting identity of a colleague's operation.
_Avoid_: Acting identity, patch owner

**Principal**:
The user identity bound when the shell opens a company patch. A later request must still have that user's session; a public version has no principal.
_Avoid_: Machine token, owning patch

**Wire version**:
The stable deployed-bundle contract a runtime request speaks, distinct from the tooling release and the patch's schema revision.
_Avoid_: Release, schema revision, transport version

**Runtime log**:
The admin-only attributed record of production mutations, integration calls and admin discovery, begun before execution; ordinary reads and local dev calls are absent. A pending outcome past its deadline is unknown, not evidence that the operation failed or is safe to replay.
_Avoid_: Call log (Integrations' pointer to this record), analytics event

**Request event**:
The best-effort operational record of one runtime request, including reads and refused attempts. Its attribution is limited to the loaded version and authenticated viewer established during admission; it is not the runtime log.
_Avoid_: Audit record, runtime-log entry

**Correlation id**:
The identifier joining an operation's failure to its runtime-log record. It is created by Patchy, never supplied by patch code.
_Avoid_: Publish key, patch id

**Stream**:
The connection carrying a company's document lifecycle frames from Patchy. A document has at most one connected stream; reconnecting replaces its generation without changing its loaded version.
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
