# Integrations

The company capability for connecting outside systems without handing credentials to patches. Postgres, PostHog and Pidgeon connections and their discovered metadata are managed here; the `connections` API group exposes their safe metadata to active members. [Companies](../companies/GLOSSARY.md) owns membership, and [Runtime](../runtime/GLOSSARY.md) uses the initiating viewer as the effective principal for connection calls.

## Language

**Integration**:
A capability Patchy ships for reaching an outside system, the same capability for every company. Postgres, PostHog and Pidgeon are built; OAuth integrations such as Salesforce and Gmail remain future work.
_Avoid_: connector, app (Zapier's word), resource (Retool and Windmill's word), toolkit

**Connection**:
A credentialed instance of an integration, used by a patch rather than owned by it. Today's company connection carries a handle and an admin description and is shared company-wide; disconnecting preserves its identity and metadata while denying new use.
_Avoid_: datasource, connected account, credential (what it holds, not what it is)

**Connection discovery**:
The member-readable list of the company's connections and their state, with declaration hints for connected ones and setup guidance for disconnected ones. Offered integrations are optional; drilling into one connection reveals its current immutable snapshot and taken-at time, or reports the snapshot unavailable.
_Avoid_: connection administration

**Catalogue**:
The integrations Patchy offers a company, each with what it reads, how it connects (company-wide or personal) and how many connections the company already has. Admins reach it from the Integrations page, which lists the company's connections, through Connect an integration; it is not that list.
_Avoid_: marketplace, app directory

**Unused**:
A connection no stored version of any company patch declares, which is exactly when it can be deleted. A connection only older versions or retired, deleted or disabled patches declare is used by no live patch, but is not unused; its row reads "None live" with how many.
_Avoid_: idle (a statement about calls), orphaned

**Personal connection**:
A future connection belonging to one user rather than their company, such as that user's Gmail. Its credentials and lifetime follow the user; the access rules live in [the product](../../docs/product.md#company-and-personal-connections).
_Avoid_: user resource, private connection

**Connection handle**:
The immutable name a company connection carries beside its integration — `warehouse` in `postgres/warehouse` — distinguishing one integration's connections in one company. Two integrations may each have a `warehouse`, so the integration and handle together name a connection. A declared connection binds to its stable identity, not a later reuse of that handle.
_Avoid_: alias, connection id (the identity, which never changes)

**Declaration**:
A patch's statement of a connection, shared table, shared file store or company member directory it uses but does not own. It binds the required resource's identity and metadata where applicable, never grants access.
_Avoid_: dependency, requirement, scope request

**Description**:
An admin's hint about a connection's purpose, helping a builder choose it. It neither grants nor restricts access.
_Avoid_: permission, policy, grant

**Metadata**:
The source's shape as discovered for one connection, never its business rows. Postgres metadata is a schema snapshot; PostHog metadata is an events snapshot; Pidgeon metadata is an address snapshot. A stored snapshot names its own integration, so it reads correctly after its connection is deleted.
_Avoid_: instance, fixture

**Schema snapshot**:
An immutable description of a connection's relations, columns, keys, enum labels and named exclusions. A failed discovery leaves the previous snapshot current.
_Avoid_: inventory (the cumulative authority for patch-owned resources), schema revision (Primitives' term)

**Events snapshot**:
An immutable list of a PostHog project's event definitions and event and person property definitions, with their types and descriptions, never events. Its types are hints for writing HogQL; a query may name anything the project has.
_Avoid_: event catalogue, schema (PostHog has none to snapshot)

**Address snapshot**:
An immutable description of one Pidgeon address: its email, display name and send policy, what Patchy's key for it may do, its labels and the account's plan, never mail. Refresh labels takes a new one with the stored key.
_Avoid_: mailbox, inbox snapshot

**Admin key**:
The Pidgeon key over the whole account an admin pastes to connect, change access or replace a key. It travels only in the bodies of that admin's own requests and is never stored, logged or shown; Patchy uses it to find or create the address and mint an address key. Revoking it revokes every key minted from it.
_Avoid_: master key, account key, root key

**Address key**:
The Pidgeon key Patchy mints for one address, at `read` or `send`, and the only Pidgeon secret it keeps. It is named `Patchy <handle> <attempt> <code>`, the code its own submission's, checked to reach exactly its address before it is saved, and revokes itself when replaced or deleted; a replaced one stays retired, saved with its replacement, until it has.
_Avoid_: scoped key, API key (Pidgeon's word for every kind)

**Send policy**:
Pidgeon's rule for who an address may write to: `reply_only`, answering only people who wrote first, `open`, or an allow-list. Addresses Patchy creates start reply-only.
_Avoid_: permission, access (what the key may do)

**Rotate key**:
A Pidgeon address key giving itself a new secret, with no admin key, while the old secret works for a grace period. It is recorded as unknown before Pidgeon is asked, so an answer that never came, or a server that stopped mid-rotation, keeps Rotate off until Replace key; it is never retried. Distinct from **Replace key**, which mints a new key with an admin key.
_Avoid_: refresh, renew (the store's name for it)

**Revision**:
The connection's server-assigned metadata revision identifying one schema snapshot. A published declaration keeps the revision it was generated against; refreshing discovery never rewrites it.
_Avoid_: snapshot revision, release, wire version, credential revision, schema revision (Primitives' term)

**Relation**:
A source table or view described in a Postgres schema snapshot. Its source name is preserved; the typed client exposes a projection of its supported columns, not a copy of every source feature.
_Avoid_: primitive table, collection

**Retarget**:
Replacing a connection's source endpoint while keeping the connection's identity and discovering its new shape. Existing declarations keep their identity and recorded snapshot. The connection page calls it Point elsewhere for Postgres and Change project for PostHog, beside Replace credentials or Replace key, which rotate them for the same endpoint. A Pidgeon connection has none: another address is another connection.
_Avoid_: rename, new connection

**Credential revision**:
The changing generation of a connection's credentials and connected state. It invalidates old source sessions independently of the metadata revision.
_Avoid_: snapshot revision, key id

**Escape hatch**:
An explicit raw SQL query with a declared result shape instead of the relation-specific typed client. It remains a constrained read through the supplied role, not harmless execution of arbitrary SQL.
_Avoid_: unrestricted SQL, direct database access

**HogQL query**:
PostHog's one operation: a named, read-only query in PostHog's ClickHouse-flavoured SQL, with constant values for its placeholders and a declared result shape. Patchy builds the request, so patch code can only read. Its **name** labels the call in recent calls and in PostHog's own query log.
_Avoid_: event export, insight (PostHog's saved chart)

**Project slots**:
The queries one server process lets run at once against one PostHog region and project, shared by every connection to it. A call that can't get one before its deadline is refused busy, having sent nothing.
_Avoid_: pool (a Postgres word for reusable sessions), rate limit (PostHog's own)

**Address slots**:
The calls one server process lets run at once against one Pidgeon address, shared by `patchy dev` and published patches. A call that can't get one before its deadline is refused busy, having sent nothing; one that waited checks its caller and connection again and loads the key as it stands.
_Avoid_: pool, rate limit (Pidgeon's own)

**Typed client**:
The integration-specific surface patch code is handed for a declared connection, rather than raw HTTP or a credential. The Postgres client exposes relation reads and the escape hatch; the PostHog client exposes one HogQL query.
_Avoid_: proxy (how it is carried out, not what the code sees), driver, raw API

**Call log**:
See **Runtime log** in [Runtime](../runtime/GLOSSARY.md); connection calls and admin discovery belong to that record, not a separate log.
_Avoid_: audit trail, analytics event (a business moment, not a call)

**Dev binding**:
How `patchy dev` runs an integration's operations, chosen per integration ([ADR-0013](../../docs/adr/ADR-0013-dev-bindings-per-integration.md)). By default it is local, over fixtures or a fake, with no production credentials or business rows. An integration whose shapes can't be known ahead and which can't write reads the real connection instead, through a dev read; PostHog does, Postgres keeps fixtures.
_Avoid_: Mock integration, production proxy

**Dev read**:
One live dev binding call: the instance runs an operation the integration opts into on a connected connection of the machine token's company, as that token's person, and logs it as a machine call with no patch. Both local viewers read as the token's person.
_Avoid_: Dev proxy, impersonated read

**Fixture**:
Builder-authored synthetic data for a declaration's local shape, with invented rows for connections and shared tables, or files for shared stores. Fixtures establish local behavior, not production data, authority or volume guarantees; view fixtures contain explicit rows rather than recomputed source data.
_Avoid_: Sample of production, mock response
