# Integrations

The future company capability for reaching outside systems: integrations, connections and the calls made through them. There is no implementation yet; [the product](../../docs/product.md#integrations) holds its decisions, [Patches](../patches/CONTEXT.md) defines primitives, [Companies](../companies/CONTEXT.md) owns membership, and [Auth](../auth/CONTEXT.md) defines the viewer.

## Language

**Integration**:
A capability Patchy ships for reaching an outside system, such as Salesforce, Gmail or Postgres. It is the same capability for every company; a connection is a particular company's or user's live instance of it.
_Avoid_: connector, app (Zapier's word), resource (Retool and Windmill's word), toolkit

**Connection**:
A live, credentialed instance of an integration, used by a patch rather than owned by it. A company connection belongs to the company and is granted to users; a personal connection belongs to one user.
_Avoid_: datasource, connected account, credential (what it holds, not what it is)

**Personal connection**:
A connection belonging to one user rather than their company, such as that user's Gmail. Its credentials and lifetime follow the user; the future access rules live in [the product](../../docs/product.md#company-and-personal-connections).
_Avoid_: user resource, private connection

**Connection handle**:
The name a company connection carries beside its integration — `warehouse` in `postgres/warehouse` — distinguishing several connections of the same integration in one company. A personal connection needs no such name.
_Avoid_: alias, connection id (the identity, which never changes)

**Declaration**:
A patch's statement of the connections it needs, naming an integration and, for a company connection, its handle. It describes a requirement, not a grant of access.
_Avoid_: dependency, requirement, scope request

**Typed client**:
The integration-specific surface patch code is handed for a declared connection, rather than raw HTTP or a credential. For example, `salesforce.query(…)` names the integration's operation instead of the transport.
_Avoid_: proxy (how it is carried out, not what the code sees), driver, raw API

**Call log**:
The record of a call through a connection: the patch, the connection and the identity it ran as. It answers who acted when the outside system sees a shared company credential.
_Avoid_: audit trail, analytics event (a business moment, not a call)
