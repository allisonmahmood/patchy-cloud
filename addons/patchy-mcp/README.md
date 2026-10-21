# Patchy MCP

An installable connector for existing Patchy Cloud content, using each person's
permissions. Run a local Streamable HTTP entry point with durable per-user OAuth sign-in and
read-only or read-and-write consent. Existing saved-login stdio remains available. Both entry points
share the same tool implementation.

| MCP tool             | Purpose                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `list_patches`       | Discover published Pages and Tools the person can open                                     |
| `get_patch`          | Read a patch's description and metadata by id or exact name                                |
| `read_page`          | Read a tier 0 Page's current published HTML, including company Pages                       |
| `list_queries`       | Describe a company tier 2 Tool's published read-only queries and input/output JSON Schemas |
| `run_query`          | Execute a discovered query with inputs, returning its actual patch/version and value       |
| `check_launch_queue` | Keep the existing `queue.blocked` shortcut working                                         |
| `list_operations`    | Read a Tool's declared queries/mutations, schemas, version and a fresh mutation key        |
| `run_mutation`       | Add, update or delete data through one declared mutation; potentially destructive          |

The six existing tools remain read-only. `list_operations` also reads only
metadata; `run_mutation` executes declared writes. Actions, publishing, patch
building, code/schema editing, and arbitrary database/resource access are outside
this connector. Page contents and operation metadata/results are data, not
instructions. All eight return an `outputSchema`, JSON text and matching `structuredContent`,
including inventory, metadata and published Page HTML. An empty result is
successful; a failed or malformed request is an MCP tool error.

## Install and connect

Follow [SETUP.md](SETUP.md) for one local HTTP walkthrough: install the supplied
archive, start the listener, connect, sign in as yourself, first use, manual
update/restart, reconnect, revoke and roll back. HTTP needs Node 22.22+ and an
OAuth-capable local MCP client; it does not need the Patchy CLI. This is local,
unreleased **0.4.2**. No public installation/download URL is provided.

Use the exact Cloud URL supplied by its owner. The connector defaults to port
**38143**, with `/mcp` for the client and `/healthz` for running build identity.
Do not reuse the Cloud database's port 38141. `serve` requires an explicit Cloud
URL and listens only on loopback; hosted clients cannot reach it. No deployment,
tunnel or automatic updater is part of this project.

```sh
patchy-mcp serve --api-url '<exact-local-cloud-url>' --port 38143 \
  --state-dir "$HOME/.local/state/patchy-mcp/local-http"
```

## Authentication and connection permission

The bridge uses the official SDK's
[authorization middleware](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization),
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
and [OAuth refresh-token rotation](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14).
Cloud remains the authority for each person's identity, company, machine and access.

- HTTP 401 advertises RFC 9728 protected-resource metadata at
  `/.well-known/oauth-protected-resource/mcp`; RFC 8414 authorization-server
  metadata is at `/.well-known/oauth-authorization-server`.
- Authorization code + PKCE S256, dynamic registration, exact redirect matching,
  issuer responses, public clients and confidential clients (`client_secret_basic`
  and `client_secret_post`) remain supported. `resource` must identify this `/mcp`
  endpoint on authorization, code exchange and refresh. Codes are one-use and
  expire in one minute; incomplete browser flows are deliberately transient.
- **Sign in to Patchy** opens Cloud's confirmation directly with the code already
  supplied. The original connecting tab waits and finishes OAuth automatically;
  no repeated link/code handoff is required. A no-JavaScript fallback remains.
- Each connection completes its own dedicated Cloud device login. HTTP never
  reuses saved CLI state, `PATCHY_API_TOKEN` or a developer's login. Every request
  checks `/api/me`; Cloud applies its own rules on every read and write.
- `patchy:tools` grants reads; `patchy:write` additionally requests writes. Consent
  defaults to **Read only** and offers **Read and write** only when requested.
  The chosen permission is persisted with that connection. Refresh cannot widen
  it; permission changes require fresh consent. All eight tools remain visible;
  read-only mutations fail as `not_attempted` before Cloud receives a request.
- Access tokens expire within one hour. Single-use refresh tokens rotate on
  every refresh; reuse invalidates the whole connection, including newly issued
  tokens. A connection expires 30 days after sign-in or at the original Cloud
  credential expiry, whichever comes first. Refresh never extends that deadline.
  Cloud revocation or changed identity prevents both access and refresh.
- The CLI persists registered clients and completed grants in a private directory
  (default `~/.local/state/patchy-mcp/<port>`, or explicit `--state-dir`). The JSON
  format is versioned and bound to the listener origin and exact Cloud URL. Files
  are atomically replaced and flushed; one process holds a lock. Invalid state
  is refused, never reset. The directory is mode 700; the file is mode 600. Access,
  refresh and client secrets are hashed; the dedicated Cloud credential must be
  stored to call Cloud. Treat this directory like a credential store and keep it
  separate from packages, source and shared folders.
- Restart the same build or install a new one with the same state directory,
  listener URL and Cloud URL to retain completed sign-ins. A client without refresh
  support must sign in again when its access token expires. No permanent tokens.
- RFC 7009 `POST /oauth/revoke` accepts the client's access or refresh token,
  invalidates its whole connection and attempts Cloud self-revocation. Cloud's
  **Your machines** page independently revokes the dedicated machine. Removing a
  client registration or stopping the process does not revoke credentials.

The bridge consumes only Cloud's existing device-start, device-poll, identity
and self-revocation APIs. No Cloud authentication changes are needed.

## Working from this repository

This package lives in `addons/patchy-mcp` inside the Patchy Cloud repository.
It runs as a separate process and keeps its own npm lockfile and dependencies;
it is outside the pnpm workspace and is not deployed with Cloud. From the
repository root, run `cd addons/patchy-mcp` before the commands below.
Cloud’s root checks do not run this package’s checks: run `npm test` and
`npm run test:packed` here when changing the connector.

## Build identity and verification

`patchy-mcp --version` prints the package version. `--build-info` and HTTP
`/healthz` include the deterministic fingerprint of source, dependency lock and
shipped instructions. The running HTTP fingerprint distinguishes a process that
still runs the old build after an installation update.

```sh
npm ci
npm test
npm run test:packed
```

Maintainers build a local bundled archive and checksum with `npm run release`;
nothing is uploaded. Packaging refuses changed bytes under an existing version.
Keep each archive/checksum, release manifest and versioned install guide for manual
update and rollback. The installed runtime needs no Cloud checkout or build tools.
See SETUP for the exact recipient installation and rollback commands.

`npm test` covers official-client discovery/registration/code exchange, current
and legacy MCP protocols, two users, access rules, restart persistence, refresh
after access expiry, rotation/replay, finite expiry, PKCE/client/resource/redirect
checks, browser CSRF/cancel, confidentiality, revocation and read-only enforcement.
It ignores developer credentials and rejects another listener's tokens. These are
local fixture tests, not evidence about a production deployment.

For a fresh device login against an existing disposable local Cloud:

```sh
PATCHY_TEST_HTTP_CLOUD_URL='<exact-local-cloud-url>' \
PATCHY_TEST_HTTP_PERSONA='<assigned-dev-persona-email>' npm run test:http-cloud
```

This opt-in test refuses nonlocal Cloud URLs and revokes only its new dedicated
login. It reads existing content without creating people or publishing a Tool.

## Declared data changes

The Cloud thread's typed API contract (`packages/api/src/api.ts`, `runtime.ts`
and `schemas.ts` in Patchy Cloud) adds only:

```text
GET  /api/patches/:patchRef/operations
POST /api/patches/:patchRef/mutation
     {"versionId":"…","handler":"…","args":{…},"mutationKey":"…"}
```

Call `list_operations` on an existing company tier 2 Tool. It returns Cloud's
`patchId`, `versionId` and operation descriptions/input/output schemas, with
`kind: "query" | "mutation"`. Actions are excluded. The connector adds a fresh
`mutationKey` (`<epoch-ms>-<16 random bytes as base64url>`) for **one intended
change**. Get a new key for a different change. For reads, keep using
`list_queries` and `run_query`.

For a change, review the declared handler and inputs, then call `run_mutation`
with `{patch, versionId, handler, args, mutationKey}`. Here `patch` must be the
canonical `patchId` from discovery. The connector refreshes metadata, checks the
same version and declared mutation kind, and makes **one POST at most**. Cloud
reauthorizes the person, validates the current Tool contract, and uses the Tool's
normal atomic transaction. No direct table or database access is introduced.

All mutations are conservatively annotated `readOnlyHint: false`,
`destructiveHint: true`, `idempotentHint: false`: a declared operation can add,
update or delete data. Read tools have the opposite annotations. The catalog's
kind and descriptions distinguish reads from changes. Cloud does not currently
publish a more precise destructive-operation flag, so the connector never
infers safety from a handler's name.

Structured mutation results identify `patchId`, `versionId`, `handler`, exact
`args`, `mutationKey` and `kind: "mutation"`. A successful `outcome: "committed"`
includes the authoritative handler `value` and Cloud's `revisions` when supplied;
these are the declared Tool's record ids, values or deletion result, together
with the input identifying the intended change. The connector does not invent
changed-row counts. `false`, `null`, zero and empty values are preserved.

Failures are MCP tool errors with a structured `outcome` and `error`:

- `not_attempted`: metadata, version or declared-kind checks failed before POST.
- `rolled_back`: Cloud returned a declared business refusal and rolled back.
- `refused`: Cloud returned a definite request/access/version/rate refusal.
- `unknown`: the change may have committed (lost response, timeout, host error,
  malformed or mismatched reply). This never becomes a successful empty result.

**No write is automatically retried.** An unknown result retains its exact key,
version, handler and inputs. Keep the same person and instance too. Any recovery
requires an explicit decision; a deliberate same-key request can recover Cloud's
stored committed value. Never mint a replacement key after uncertainty, change
the inputs, or automatically move to a newly published version. A version-change
refusal does not resolve an earlier unknown outcome. Keys are accepted by Cloud
for 24 hours with five minutes of future-clock tolerance.

The mutation tests use disposable HTTP fixtures for add/update/delete, rollback,
concurrent authenticated callers, version changes, absent/action/query handlers,
lost response after commit, explicit same-key recovery and one-POST assertions.
The opt-in business acceptance below exercises these contracts against the
existing Brightline CRM in a disposable Cloud copy. It uses the Tool's existing
handlers and access rules, without adding a test-only operation to that Tool.

## Repeatable business Tool acceptance

Use a **new disposable Cloud checkout**, with its own database and environment
directory. Do not point these write tests at a saved demo or an existing person's
instance. In that checkout, use the pinned pnpm version to install and run:

```sh
pnpm install --frozen-lockfile
XDG_DATA_HOME="$PWD/.local/acceptance-data" pnpm dev up brightline
```

The scenario supplies the existing `new-business` CRM, sample deals, Allison
(admin) and Jordan (member). Copy the local URL printed by `up`, then in this
MCP checkout run:

```sh
export PATCHY_TEST_BUSINESS_CLOUD='http://<label>.localhost:<port>'
export PATCHY_TEST_BUSINESS_DISPOSABLE=1
# Optional: run actual Codex model turns too; requires a working Codex login.
export PATCHY_TEST_BUSINESS_AGENT=1
npm run test:business
```

Without the explicit URL and disposable flag, these tests skip. They refuse
non-local Cloud URLs. Each user signs in with a separate dev-persona device
login, and only those new machine credentials are revoked afterward. Agent
settings apply to that invocation only: no saved MCP registration is written.
The model can use only this MCP for the task; shell and web access are disabled.
Only its mutation tool is preapproved for the requested disposable test writes.
An authentication/model failure fails acceptance; it is never counted as a pass.
The harness keeps the saved Codex model choice. `PATCHY_TEST_AGENT_MODEL` can
select another accessible model; `PATCHY_TEST_CODEX_COMMAND` can select a
different installed Codex executable without changing PATH or installing one.

The direct test checks operation schemas, both users' shared board reads, a
member editing an admin-owned deal, refused member closure/reassignment,
successful admin closure, missing arguments, and an undeclared delete. Refusals
must leave the timeline unchanged. The model test asks in ordinary language to
create/read/edit test deals, handles two deals for the same client, asks for
missing creation inputs, and checks both users' closure permissions. Ambiguous
or incomplete requests must ask a question without submitting a mutation.
Both tests compare pre-existing deals afterward. Optional
`PATCHY_TEST_BUSINESS_EVIDENCE=/existing/directory` saves model prompts, actual
MCP calls/results and final answers, without credentials or model reasoning.

**Deletion boundary:** the existing CRM declares no delete handler. The agent
must explain that limitation and preserve the record; this is not successful
delete acceptance. Adding deletion would change the business Tool's behavior
and is outside this connector check. Test-created deals therefore remain only
in the disposable database until teardown. From the disposable Cloud checkout:

```sh
XDG_DATA_HOME="$PWD/.local/acceptance-data" pnpm dev down
```

Never run that teardown against the original checkout or someone else's instance.

## Query discovery and execution

An agent first calls `list_patches`, chooses a company tier 2 Tool, and calls
`list_queries` with its id or exact name. Each query includes a `handler`, purpose
description, `inputSchema` and `outputSchema`. Required fields, optional fields,
enums and local `$defs` are preserved. The output schema describes the successful
query's value.

The agent calls `run_query` with `{patch, handler, args}`. `args` is the input object
described by the query schema, or `{}` for an operation without inputs. The result
is `{patchId, versionId, handler, value}`, in text and structured content. Values
such as `false`, `null`, `0` and empty arrays remain intact.

Discovery is fetched afresh. Every execution refreshes the catalog, rejects
handlers absent from it, and calls the query endpoint using its canonical patch
id. Cloud rechecks permissions and validates the currently published input/output
contract. The returned version identifies what actually ran. The connector does
not execute patch code, fetch remote schemas, or maintain a handler registry.
Another published Tool with different inputs needs no MCP change or rebuild.

## Authentication and API contract

Set `PATCHY_API_URL` to the exact disposable instance URL for a test. The default
is `https://cloud.patchyhq.com`. Setup persists the selected URL.

Without `PATCHY_API_TOKEN`, discovery uses `patchy list --json`, identity uses
`patchy whoami --json`, and Page/query reads obtain a host-bound credential via
`patchy auth token --json`. MCP re-reads credentials for each request, so completed
re-login repairs an existing connection. It never reads private credential files.
`PATCHY_STATE_DIR` selects an isolated demo login. Direct test launches also accept
`PATCHY_API_TOKEN`; the Codex setup helper uses saved login and stores no token.

An older CLI can support discovery without supporting Page/query credential
access. Install the matching CLI from the selected instance's `/llms.txt`.
`doctor` checks identity and credential access, without reading a Page or invoking
a query. It does not establish that discovery routes or test content are deployed.

The tools use these existing Cloud contracts:

```text
GET  /api/patches
GET  /api/patches/:patchRef
GET  /api/patches/:patchRef/page
GET  /api/patches/:patchRef/queries
POST /api/patches/:patchRef/query  {"handler":"<discovered handler>","args":{...}}
```

The selected instance must expose the Page, credential and query-discovery
contracts above. This is a server capability requirement, not something installing
MCP adds to Cloud. Ask the local Cloud owner which contracts its build supports; do not infer
capability from a remembered port or old demo. A hosted Cloud or older CLI may
not support this development contract.

Query metadata requires a live company tier 2 Tool. Other tiers return 400; off
Tools return 409. A 401 requests sign-in repair, 403 reports refused access, and
404 means missing or inaccessible content. A non-JSON 404 can also mean an instance
without the route or a wrong URL; it cannot establish which. Network failures,
timeouts and 5xx report unavailable Cloud. Handler refusals include their code and
details. Failed or malformed responses never become empty successful results.

The Launch Queue compatibility shortcut still accepts `{}` and uses the published
`queue.blocked` query. `PATCHY_LAUNCH_QUEUE_PATCH` optionally pins its patch id;
otherwise it resolves `launch-queue` in the person's company. Its blocked items
and total are validated as before.

## Read-tool verification boundaries

`npm test` uses HTTP fixtures and real stdio processes. It covers discovery,
Pages, generic queries with required inputs, a second Tool appearing on the same
connection, read-only operation checks, malformed replies, saved-login recovery,
setup/removal, and distinct errors. `npm run test:packed` checks the installed
archive and all eight tools. These tests do not prove a real Cloud deployment works.
The installed runtime is also checked for developer paths, and uninstall is
verified to preserve separate login state. `npm run test:codex` is a separate,
opt-in check through the real Codex app-server's saved MCP registration; it uses
the same content-selection variables plus `PATCHY_TEST_CODEX_SERVER`. It makes
direct MCP calls without a model turn, so it is not natural-language acceptance.

The official server and client SDKs are pinned to **2.3.1**. Tests explicitly
exercise protocol **2026-07-28** through both the SDK and independent JSON-RPC:
`server/discover`, `tools/list`, `tools/call`, result envelopes, response identity,
cache fields, invalid revisions/envelopes, unknown methods/tools, tool errors,
recovery, JSON-only stdout and EOF. Legacy checks negotiate `2024-10-07`,
`2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25`. Production uses the SDK's
default `serveStdio(factory)` backward compatibility without protocol shims. See
the [official SDK protocol guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

Separate real Cloud assertions are read-only and require an explicit URL and test
selection:

```sh
export PATCHY_API_URL='<exact-instance-url>'
# Preserve the handoff's PATH and PATCHY_STATE_DIR for its saved login.
export PATCHY_TEST_PAGE='<exact-company-page-name>'
export PATCHY_TEST_TEXT='<expected-page-text>'
export PATCHY_TEST_LAUNCH_QUEUE=1
export PATCHY_TEST_QUERY_PATCH='<second-tool-id-or-exact-name>'
export PATCHY_TEST_QUERY_HANDLER='<published-query-handler>'
export PATCHY_TEST_QUERY_ARGS='<JSON input object with at least one field>'
export PATCHY_TEST_QUERY_EXPECTED='<expected result.value as JSON>'
npm run test:cloud
```

Choose any subset of the Page, Launch Queue and generic-query tests. Text and
expected-value assertions are optional. Optional `PATCHY_TEST_TOTAL` and
`PATCHY_TEST_BLOCKER` check Launch Queue facts; `PATCHY_TEST_MCP_COMMAND` selects an
installed executable. Both protocol eras are exercised. These tests never seed,
publish, reset or stop Cloud. Natural-language acceptance additionally requires an
agent to discover and execute the second Tool with inputs through MCP, using its
published descriptions and schemas; a direct SDK/app-server call alone is not
that acceptance test.
