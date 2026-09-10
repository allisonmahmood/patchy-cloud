# Integrations

The company capability for connecting outside systems without handing credentials to patches. Postgres connections and their discovered metadata are managed here; [Companies](../companies/CONTEXT.md) owns membership and [Runtime](../runtime/CONTEXT.md) binds operations to the acting viewer.

## Language

**Integration**:
A capability Patchy ships for reaching an outside system, such as Salesforce, Gmail or Postgres. It is the same capability for every company; a connection is a particular company's or user's live instance of it.
_Avoid_: connector, app (Zapier's word), resource (Retool and Windmill's word), toolkit

**Connection**:
A credentialed instance of an integration, used by a patch rather than owned by it. Today's company connection is shared company-wide; disconnecting preserves its identity and metadata while denying new use.
_Avoid_: datasource, connected account, credential (what it holds, not what it is)

**Personal connection**:
A connection belonging to one user rather than their company, such as that user's Gmail. Its credentials and lifetime follow the user; the future access rules live in [the product](../../docs/product.md#company-and-personal-connections).
_Avoid_: user resource, private connection

**Connection handle**:
The immutable name a company connection carries beside its integration — `warehouse` in `postgres/warehouse` — distinguishing connections in one company. A declared connection binds to its stable identity, not a later reuse of that handle.
_Avoid_: alias, connection id (the identity, which never changes)

**Declaration**:
A patch's statement of a connection or shared table it uses but does not own. It names an integration and connection handle, or a source patch's id and table; it describes a requirement, never a grant of access.
_Avoid_: dependency, requirement, scope request

**Description**:
An admin's hint about a connection's purpose, helping a builder choose it. It neither grants nor restricts access.
_Avoid_: permission, policy, grant

**Metadata**:
The source's shape as discovered for one connection, never its business rows. Postgres metadata is a schema snapshot.
_Avoid_: instance, fixture

**Schema snapshot**:
An immutable description of a connection's relations, columns, keys, enum labels and named exclusions. A failed discovery leaves the previous snapshot current.
_Avoid_: inventory (the cumulative authority for patch-owned resources), schema revision (Primitives' term)

**Metadata revision**:
The connection's server-assigned snapshot identifier. A published declaration keeps the revision it was generated against; refreshing discovery never rewrites it.
_Avoid_: release, wire version, credential revision

**Relation**:
A source table or view described in a Postgres schema snapshot. Its source name is preserved; the typed client exposes a projection of its supported columns, not a copy of every source feature.
_Avoid_: primitive table, collection

**Retarget**:
Replacing a connection's source endpoint while keeping the connection's identity and discovering its new shape. Existing declarations keep their identity and recorded snapshot.
_Avoid_: rename, new connection

**Credential revision**:
The changing generation of a connection's credentials and connected state. It invalidates old source sessions independently of the metadata revision.
_Avoid_: snapshot revision, key id

**Escape hatch**:
An explicit raw query instead of the relation-specific typed client. It remains a constrained read through the supplied role, not harmless execution of arbitrary SQL.
_Avoid_: unrestricted SQL, direct database access

**Typed client**:
The integration-specific surface patch code is handed for a declared connection, rather than raw HTTP or a credential. For example, `salesforce.query(…)` names the integration's operation instead of the transport.
_Avoid_: proxy (how it is carried out, not what the code sees), driver, raw API

**Call log**:
The record of a call through a connection: the patch, the connection and the identity it ran as. It answers who acted when the outside system sees a shared company credential.
_Avoid_: audit trail, analytics event (a business moment, not a call)

**Dev binding**:
The local implementation of an integration's supported operations, using synthetic data instead of production credentials or business rows. It preserves the operation contract while making its limits explicit.
_Avoid_: Mock integration, production proxy

**Fixture**:
Agent-authored synthetic rows for a declared connection's local shape. A view fixture holds explicit rows rather than recomputing from its source tables.
_Avoid_: Sample of production, mock response
