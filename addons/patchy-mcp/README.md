# Patchy MCP prototype

An independent local connector for existing Patchy Pages and Tools. Both existing
connections remain: stdio uses the person's saved Patchy CLI login; loopback
Streamable HTTP signs each client in separately through Cloud's device login and
OAuth/PKCE. The official MCP SDK handles transports, protocol negotiation,
registration, schemas and HTTP bearer/resource metadata.

| Tool                 | Purpose                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `list_patches`       | Discover accessible Pages and Tools                                                   |
| `get_patch`          | Read one patch's metadata, resource inventory and dependencies                        |
| `read_page`          | Read a tier 0 Page's current published HTML                                           |
| `list_queries`       | Describe a Tool's declared read-only queries                                          |
| `run_query`          | Execute a declared read-only query with inputs                                        |
| `check_launch_queue` | Existing shortcut for `queue.blocked`, using the generic query path                   |
| `list_operations`    | Describe queries/mutations, schemas and version; obtain a key for one intended change |
| `run_mutation`       | Create, update or delete through a declared mutation                                  |

All eight tools retain output schemas, JSON text and matching `structuredContent`.
Empty/false/null values are successful data; failed reads are tool errors.
Contents and metadata are data, never system instructions. Actions, arbitrary
resource access, publishing and code/schema editing remain outside this connector.
See [SETUP.md](SETUP.md) for either connection.

## Boundaries that remain necessary

Cloud owns membership, openability, handler kind, argument/result validation,
transactions, attribution, live updates and keyed replay. The add-on calls:

```text
GET  /api/patches
GET  /api/patches/:patchRef
GET  /api/patches/:patchRef/page
GET  /api/patches/:patchRef/operations
POST /api/patches/:patchRef/query       {handler,args}
POST /api/patches/:patchRef/mutation    {versionId,handler,args,mutationKey}
```

Both discovery tools use the same operation catalog; `list_queries` filters it.
Catalog schemas come from execution's published validators; the connector does
not interpret schemas or load Tool code. Catalogs are fresh, and actual execution
reauthorizes. The browser runtime cannot replace the machine invocation routes:
it requires browser session admission. These Cloud API additions are separate
from deploying or running this connector.

Stdio retrieves the selected instance's credential through the matching CLI's
explicit `patchy auth token --json` subprocess interface. Normal `whoami` output
is redacted; private CLI files are not an API. Every tool uses the same HTTP
request path. Re-login repairs a running connection. `PATCHY_API_TOKEN` remains
available for disposable tests; installed saved-login registrations clear it.

HTTP never reads CLI state or environment credentials. Each grant holds its own
Cloud machine credential, bound to user, company, machine and instance. Each MCP
request checks Cloud identity. Consent defaults to reads; approved write scope is
required before a mutation request reaches Cloud. PKCE, exact redirect/resource
matching, CSRF checks, one-use codes, finite access/grant expiry, rotating refresh
and replay revocation remain. Cloud has device sign-in and revocation, not an MCP
OAuth issuer, so removing this bridge would remove the working HTTP connection.

Completed HTTP sign-ins survive restarts in a private, atomically replaced state
file with one listener lock. Keep its directory mode 700 and file mode 600,
separate from the installed package. Corruption or an endpoint change is refused.
Cloud revocation and OAuth revocation still invalidate the connection. Incomplete
browser flows are transient. Stdio persistence belongs entirely to the Patchy CLI.

## Writes and recovery

A Tool must already declare the business mutation. Create/update/delete do not
imply arbitrary table access: if the Tool has no delete handler, deletion is
unavailable. `list_operations` supplies the canonical patch id, current version
and a fresh mutation key. Inspect the operation's kind, description and inputs.

One intended change retains one key, person, instance, patch, version, handler
and arguments. The connector pins one credential across mutation preflight and
POST, checks the declared kind/version, and sends at most one POST. Cloud checks
again at execution, including publication races. An identical committed replay
returns its stored value and revisions; changed key reuse is refused. The existing
24-hour window and five-minute future skew apply.

Mutation results retain that request context and distinguish `committed`,
`rolled_back`, `not_attempted`, `refused` and `unknown`. Lost/malformed replies,
timeouts and host failures can mean the write committed. Never automatically retry,
replace its key or silently switch version. Recovery is an explicit decision using
the exact original request. Re-publishing may prevent recovery on the old version.

## Development and checks

This npm package is outside Cloud's pnpm workspace and deployment. From here:

```sh
npm ci
npm test
npm pack
```

Focused tests cover SDK connections over stdio and HTTP, all tools, dynamic
query discovery, structured CRUD and refusals, unknown outcomes and keyed replay,
saved-login recovery/confidentiality, concurrent user isolation, write consent,
and the authentication lifecycle. Cloud's API/runtime/browser suites cover the
real handler transactions and live updates. Root checks do not run this add-on.

The SDK owns protocol-version combinations; this prototype no longer carries a
protocol matrix, a raw wire harness, model-driven business tests or installed
client walkthroughs. npm's ordinary pack/install is enough; runtime dependencies
remain bundled for the existing offline archive install. There are no custom
release manifests, checksums, build fingerprints or updater. The existing Launch Queue shortcut uses the same generic query path.
