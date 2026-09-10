# Runtime

Runtime is the path by which a loaded patch asks Patchy to act as its viewer. It binds each operation to the loaded version and the viewer, without handing the patch a credential.

## Language

**Operation**:
One named request a patch makes through Patchy, with its own input and result contract. An operation is a read, a mutation, or an integration call.

**Binding**:
The trusted context of one admitted operation: its company, owning patch, loaded version and manifest, acting principal, wire version and correlation id.
_Avoid_: Client context, payload identity

**Acting identity**:
The viewer whose authority an operation uses and whose actions it attributes. This is distinct from the owning patch and its owner.
_Avoid_: Patch owner identity

**Owning patch**:
The patch whose loaded version declares the resources an operation can reach. Ownership of a patch never makes its owner the acting identity of a colleague's operation.

**Principal**:
The user identity bound when the shell opens a company patch. A later request must still have that user's session; a public version has no principal.

**Wire version**:
The stable deployed-bundle contract a runtime request speaks, distinct from the tooling release and the patch's schema revision.

**Runtime log**:
The attributed record of each mutation and integration call, begun before execution. A pending outcome past its deadline is unknown, not evidence that the operation failed or is safe to replay; ordinary reads have no log entry.

**Correlation id**:
The identifier joining an operation's failure to its runtime-log record. It is created by Patchy, never supplied by patch code.
