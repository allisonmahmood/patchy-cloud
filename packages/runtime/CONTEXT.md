# Runtime

Runtime is the path by which a loaded patch asks Patchy to act as its viewer. It binds each operation to the loaded version and the viewer, without handing the patch a credential.

## Language

**Operation**:
One named request a patch makes through Patchy, with its own input and result contract. An operation is a read, a mutation, or an integration call.
_Avoid_: endpoint (the transport, not the operation), arbitrary request

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

**Correlation id**:
The identifier joining an operation's failure to its runtime-log record. It is created by Patchy, never supplied by patch code.
_Avoid_: Publish key, patch id
