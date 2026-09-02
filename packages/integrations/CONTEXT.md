# Integrations

The company-scoped primitive that reaches outside systems. This context owns what Patchy ships (the integration), what a company or a user holds (the connection), how a patch declares and is handed one, and the record every call leaves. Not yet in code: the package arrives with the integration layer, and this glossary was written first so it lands where the map says. Which primitives a patch may declare, and what a primitive is, is [Patches](../patches/CONTEXT.md)'; whose grant a call runs under is [Companies](../companies/CONTEXT.md)'; the identity patch code acts as is [Serving](../serving/CONTEXT.md)'s.

## Language

**Integration**:
A capability Patchy ships — Salesforce, Gmail, Postgres — built and maintained by Patchy, the same for every company, declaring the connection mode or modes it supports: company, personal, or both. A company-scoped primitive. There is no bring-your-own source: companies request integrations and Patchy builds them.
_Avoid_: connector, app (Zapier's word), resource (Retool and Windmill's word), toolkit

**Connection**:
The live, credentialed instance of an integration. Company mode: connected once by an admin, granted to groups or company-wide, carrying a handle alongside its integration (`postgres/warehouse`) so a company can hold many per integration. A patch uses it through the cloud as the viewer — the credential applied server-side, the viewer's grant checked, every call logged — and patch code never sees the credential at any tier.
_Avoid_: datasource, connected account, credential (what it holds, not what it is)

**Personal connection**:
A connection in personal mode: one user's own — their Gmail — made by the user with no admin involved, at most one per integration per user, dying with the account (credential wiped, stored data kept). Holding it is sufficient: any patch the user opens that declares the integration acts on it as them, with no per-patch consent step.
_Avoid_: user resource, private connection

**Connection handle**:
The name a company connection carries beside its integration — `warehouse` in `postgres/warehouse` — so a company can hold two databases or a production and a sandbox CRM. Per integration per company, first-come. A personal connection has none: a user holds at most one per integration.
_Avoid_: alias, connection id (the identity, which never changes)

**Declaration**:
The line in a patch repo naming a connection the patch needs — the integration and, for a company connection, its handle — written the way the tier is. Not a permission: it lets the CLI build against what the company actually holds and lets publish say when a named connection does not exist. Patch code is written against the promise that every declared connection is present.
_Avoid_: dependency, requirement, scope request

**Typed client**:
What patch code is handed for a declared connection: one client per integration from the SDK — `salesforce.query(…)` — never raw HTTP against the source and never a credential. Building and maintaining that surface is why Patchy builds integrations instead of letting each company wire its own.
_Avoid_: proxy (how it is carried out, not what the code sees), driver, raw API

**Call log**:
The record every call through the layer leaves: the patch, the connection, and the identity it ran as. Company-mode calls reach the source under the shared credential, so the log is where "who acted" is answered.
_Avoid_: audit trail, analytics event (a business moment, not a call)
