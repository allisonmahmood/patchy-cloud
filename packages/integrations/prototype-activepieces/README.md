# Activepieces module prototype

Local, throwaway connector catalog. `prototype/activepieces-patch-runtime` extends
`prototype/activepieces-slack-thread-read` (#927), which extends
`prototype/activepieces-connection-catalog` (#925), which branched from
pushed `prototype/activepieces-slack-token` (#923). That branch
rebased the earlier prototype onto main at `8a278cb4`. No Nango implementation is
continued. Production has no community implementation. This branch adds an
experimental wire/config shape and local host support; it changes no release or
migration and enables no production connector.

## Connector catalog inside local Patchy

```sh
npm --prefix packages/integrations/prototype-activepieces ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/integrations/prototype-activepieces run local:catalog
```

Open the printed Customer A link, or **Connections → Explore connectors (local
prototype)**. Pick a provider, enter credentials, and choose **Test and connect**.
The same form renderer takes field labels, secret/text types, required flags and
instructions from each pinned piece. Validation uses the piece's existing auth
validator. After connecting, the module's admitted read action is a button on its
connection. Enter credentials only in Patchy, never in chat, source files or URLs.

| Provider | Customer setup                                                                                                                                                                                                  | Admitted existing action                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Resend   | Create an API key in account settings. List Domains requires **Full access**; a Sending access key cannot read domains. No OAuth app is required for this mode.                                                 | `list_domains`                                                           |
| Slack    | Supply an **existing installed app's** bot token. List Channels needs `channels:read`; Get Thread Replies can use `im:history` in a DM the bot belongs to. Activepieces does not provide tokens or permissions. | `slack_list_channels` (public, non-archived), `slack_get_thread_replies` |

The catalog states these requirements before credential entry. It does not
register provider apps, perform OAuth, send Slack messages or send emails. The
module's auth validator confirms credentials; it does not certify least-privilege
scopes or access to every action. Resend's validator can accept a Sending access
key even though List Domains then fails; use the Full access key described above.

The two invented customer companies start without provider credentials. Each may
have multiple connections. Use a separate browser profile for Customer B;
switching persona in one profile changes all its tabs. Replace credentials,
disconnect (which erases saved credentials), reconnect, delete a disconnected
connection, and recent call outcomes are available on each provider page.
`local:slack` remains a launcher alias, and the previous `/community/slack` URL
still serves Slack. Stop with `local:stop` before switching to the inherited
PostHog mock's `local` command. State survives restart; `pnpm dev down` removes it.

## How another connector is admitted

`catalog.ts` is the host's policy: package/version/export, selected authentication
mode/fields, setup requirements, and enabled action names with fixed properties.
The npm lockfile pins tarball integrity; startup checks the installed version.
Adding a compatible reviewed module requires a dependency pin and catalog entry,
not a new provider form, connection service or HTTP implementation. This is not
an npm installer or automatic admission of every community piece.

`Pieces.ts` loads the admitted modules through `adapter.ts`, obtains metadata in
an isolated worker, and shares the supported authentication mappings:
`SECRET_TEXT` becomes the module's `secret_text` credential; `CUSTOM_AUTH` becomes
its `props` record for action execution. Validators receive the corresponding raw
secret or properties. Only selected secret/text fields are rendered; missing
validators, missing required fields and unsupported field types fail admission.
Slack's optional user token is intentionally excluded because the admitted
public-channel action needs only its bot token. OAuth is not admitted.

**Get Thread Replies** takes a conversation ID and the parent message's timestamp
through the same form renderer, using the action's field labels and descriptions.
For a bot DM this uses existing `im:history` permission; a token may be valid for
that read while lacking `channels:read` for channel discovery. Paste a known ID
and parent timestamp rather than relying on discovery. Slack still checks the
token's scopes, membership and access to that conversation. This does not make
every Slack conversation available. The upstream action can fetch up to 50 pages
(10,000 replies), subject to this adapter's five-second and 8 MB limits; large or
rate-limited threads may fail. Continuation cursors are not exposed in this spike.

Admission declares each action's host-fixed `props` and selected `inputs`.
Only selected `SHORT_TEXT` inputs are supported here. Missing required, duplicate,
oversized or unknown inputs are rejected before provider execution. Inputs cannot
override fixed properties or credentials, and their values are not written to call
logs. No per-user conversation ID, timestamp or credential belongs in the catalog.

`CommunityConnections.ts` and `CommunityPages.ts` serve every admitted provider.
They reuse Patchy's existing `connections` table as `activepieces:<key>`, AES-GCM
`CredentialKeys` (company/id/integration binding), current membership/admin checks,
same-origin POST protection and `RuntimeLog`. Queries include both company and
provider; supplying another provider's or company's id fails before decryption
or provider HTTP. Secrets are encrypted as a versioned JSON field record and are
not returned in HTML, results or logs. Existing raw Slack credentials remain
readable; replacement upgrades them to the new format. Going back to the older
Slack-only prototype after writing the new format requires re-entering those
credentials there. Production's native stores ignore community connection kinds.

Workers retain the five-second bound, empty inherited environment and suppressed
raw output. Credentials travel privately over IPC. The worker keeps TLS
verification enabled despite an upstream helper trying to disable it. This is
process separation for reviewed code, not an OS sandbox for untrusted modules.

## A real local patch

`prototype/activepieces-patch-runtime` extends the thread-read branch (#927).
The local entrypoint supplies generation, publish validation and the
`community.call` runtime handler. Normal startup supplies no community support
and refuses these declarations/calls. This is an experimental wire/config shape.

After `local:catalog` is running and a company has a saved connection:

```sh
npm --prefix packages/integrations/prototype-activepieces run local:patch -- \
  --company ap-customer-a --piece slack --handle workspace \
  --action slack_get_thread_replies
```

This initializes, refreshes and publishes `community-demo` to the **local instance
only**, using the ordinary CLI and generated client. Open its printed sign-in
link, enter the known conversation ID and parent timestamp, and run the read.
Optional `--inputs '{"channel":"D_EXAMPLE","threadTs":"1700000000.000001"}'`
prepopulates non-secret fields. Never pass credentials. Generated repos live in
`.local/dev/community-patches/`. The custom seed adds local CLI machine tokens
for the two invented companies, and still preloads no provider credentials.

A `community` declaration pins the piece/version, connection handle/id,
metadata revision and allowed action names. Generation resolves the company's
handle and creates methods from admitted module text fields. Publish revalidates
and locks the connection row. Runtime derives company/principal from existing
authorization, resolves only declared aliases, checks current connection state,
decrypts server-side, runs the pinned module, and rejects results if credentials
changed during the call. `RuntimeProduction` records viewer, patch, version,
connection and action; input values and results are not copied into logs.
Active company members may read through their declaring patch; administration
remains admin-only. Disconnected connections deny patch reads; reconnect restores
them. Deletion is refused while any stored patch version declares the connection.

Only **published, company-scoped tier 1 pages** are supported. Tier 2 callbacks,
public pages, `patchy dev` bindings, native discovery, OAuth and immutable
action-schema snapshots remain unimplemented. Results use generic JSON types.
The module version is checked on generation, publish and calls. Reverting to the
parent cannot serve these new manifests; discard the disposable dev instance
when switching back.

## Evidence and limits

`catalog.test.ts` loads the unchanged pinned Slack and Resend modules with their
transport redirected to loopback **mock providers**. It checks both credential
shapes, distinct companies and provider kinds, credential selection and encryption,
cross-company and cross-provider denial before HTTP, unadmitted write-action and
field rejection, safe auth/upstream failures, logs, disconnect/reconnect and legacy
Slack credential reads. `render.test.ts` checks module-driven field semantics,
escaping and visible setup requirements. Tests do not prove real provider access.
The local browser mode makes **real requests** with supplied credentials. Real
interactive results are recorded in the PR without message text or credentials.
Generated-client tests use real runtime/crypto/SQL/logs with loopback provider
doubles and an in-memory published-version lookup. They do not prove two real
Slack installations. The browser example publishes a real patch.

Provider-specific work remains: field/action admission, auth-version differences,
permissions, results, rate limits, pagination and extra worker context. The selected
Resend action returns its response page without following pagination. Unsupported
context fails explicitly. OAuth/refresh, triggers, webhooks, background execution,
dynamic fields, a general action-input editor, production network controls and a
complete bundle dependency/license inventory remain outside this proof. Two
modules do not establish catalog-wide compatibility.

Community source is MIT under the root license with enterprise-directory
exclusions; see `NOTICE.md`. No paid connector subscription, Activepieces server,
hosted OAuth broker or enterprise code is used. Provider accounts, quotas, terms
and credentials remain separate. In particular, [Slack's API terms](https://slack.com/terms-of-service/api)
require separate authorization for commercial distribution, subject to their
exceptions. Bot-token entry does not resolve that commercial blocker. This local
proof is not commercial-distribution or complete SBOM clearance.

## Run

From the worktree root, with its usual dependencies installed:

```sh
npm --prefix packages/integrations/prototype-activepieces ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/integrations/prototype-activepieces run demo -- --reporter=verbose
npm --prefix packages/integrations/prototype-activepieces run typecheck
```

The demo uses the repo's disposable embedded Postgres harness. Its migrated test
database and loopback HTTP simulator are closed and removed at teardown. It needs
no provider account, real credentials, Activepieces server, subscription or Docker.
Dependency installation downloads the pinned npm package; this is not a runtime
dependency on Activepieces Cloud.

## Inherited PostHog mock in a browser

From the worktree root:

```sh
npm --prefix packages/integrations/prototype-activepieces run local
```

This starts the worktree's full local Patchy server on loopback with dev-persona
sign-in, then seeds **Customer A** (`alice@customer-a.example`, project 101) and
**Customer B** (`bob@customer-b.example`, project 202). Each has its own encrypted
`posthog/analytics` connection and published `activepieces-demo` patch. The
launcher prints both signed-in patch links. Use separate browser profiles or
private windows to keep their cookies separate.

Press **Run action** to load that company's simulated results. **Try unsupported
input** shows a refusal before provider HTTP. Use Patchy's existing Connections
page to read the call log, disconnect, test the refusal, and reconnect. While
signed in to A, opening B's patch address must be refused.

**The provider is a loopback simulator, not PostHog.** It accepts only the two
dummy keys in `customers.ts` and the demo query. The local entrypoint refuses
production, public origins and non-persona authentication. There is deliberately
no option to paste a real key into this simulator. Its connection screens work
normally, but a real key will be rejected by the simulator.

The launcher is repeatable: a running prototype is reused, existing connection
states are preserved, and the demo patches are refreshed and republished. It
refuses to replace a different running dev instance. State and the generated
patch repos live in `.local/dev/`. No dependencies or CLIs are installed globally.

```sh
npm --prefix packages/integrations/prototype-activepieces run local:status
npm --prefix packages/integrations/prototype-activepieces run local:logs
npm --prefix packages/integrations/prototype-activepieces run local:stop
```

After server code edits, stop and run `local` again. Plain `pnpm dev` starts
the normal native integration, not this adapter. `pnpm dev down` deletes the
disposable instance and its generated patch repos; it is not needed to restart.
The shared dev supervisor accepts an alternate entrypoint, and `Server` exposes
alternate PostHog-source composition; their defaults are unchanged. Only this
prototype launcher selects the alternate entrypoint.

## What runs

`adapter.ts` loads a module by a host-controlled path and export name, discovers
its action names, and admits only the host's selected actions. `worker.cjs` runs
the original action with `auth` and `propsValue`. Other context capabilities fail
explicitly. No HTTP operation is reimplemented in the adapter.

`posthog.ts` is the provider-specific glue: it maps Patchy's stored credential
fields to the piece's custom API-key auth fields and maps the action's result to
Patchy's existing query result. The actual endpoint construction, bearer header,
request body and HTTP call come from the unmodified published
`@activepieces/piece-posthog@0.7.1` action `run_hogql_query`.

The dependency is installed only in this directory. `package-lock.json` pins its
tarball integrity. Its npm `gitHead` is
[`bd21dda7613f2157d6d988dac4011eb559896c44`](https://github.com/activepieces/activepieces/tree/bd21dda7613f2157d6d988dac4011eb559896c44).
The relevant upstream [action](https://github.com/activepieces/activepieces/blob/bd21dda7613f2157d6d988dac4011eb559896c44/packages/pieces/community/posthog/src/lib/actions/ai/run-hogql-query.ts)
and [auth/client](https://github.com/activepieces/activepieces/blob/bd21dda7613f2157d6d988dac4011eb559896c44/packages/pieces/community/posthog/src/lib/common/client.ts)
were inspected alongside the published bundle.

The demo keeps Patchy's real `SqlConnectionStore`, `CredentialKeys`, PostHog
operation handler, generated browser client, `RuntimeApi`, `RuntimeProduction`,
viewer/company checks, result shaping and `RuntimeLog`. Native connection
validation/discovery uses the existing PostHog HTTP double; invocation queries
use the Activepieces action over a loopback HTTP simulator. Published-version
lookup is an in-memory test layer, and session JWTs are signed offline fixtures.
The local browser demo instead publishes real tier 1 patches and signs in through local dev
personas. There is no hosted workerd deployment in this milestone.

## Evidence

The local browser demo was exercised in isolated browser contexts: A returned
project 101 / 12 events, B returned project 202 / 34 events, both cross-company
patch requests returned 404, and unsupported input returned `invalid_query`.
The existing Connections page showed each viewer's successful and refused calls.
Disconnecting A made its browser action return `access_denied`; reconnecting
restored its original result. Screenshots are kept locally under `.local/shots/`.

Two tests exercise the following scenario and adapter refusal cases:

| Caller                                                                         | Stored connection                           | Simulated provider observation                             | Client result                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| Company A (`cmp_dev`)                                                          | `posthog/analytics`, project 101            | Exact dummy A bearer key, project 101                      | `{ n: 101 }`                                  |
| Company B (`cmp_ap_b`)                                                         | Same handle, separate identity, project 202 | Exact dummy B bearer key, project 202                      | `{ n: 202 }`                                  |
| A opening B's patch                                                            | B's patch identity                          | No request                                                 | `access_denied`                               |
| Either company with a corrupted declaration pointing to the other's connection | Other company's connection id               | No request                                                 | `access_denied`                               |
| Undeclared alias / injected auth and company arguments                         | No authorized target                        | No request                                                 | `connection_not_declared` / `invalid_request` |
| Disconnected A, then reconnected A                                             | Stable A connection identity                | No request while disconnected; dummy A key after reconnect | Denied, then `{ n: 101 }`                     |

Additional assertions verify ciphertext contains neither dummy key, decryption
fails with the wrong company in authenticated associated data, direct cross-company
credential lookup fails, and another company's successful call cannot be read by
correlation id. Each successful call records the correct company, viewer,
connection, query name and row count. Refused corrupt declarations leave a failure
record under the caller's company, not a successful provider call.

The simulator deliberately echoes a dummy key in an upstream error. Patch output
and stored call logs contain neither key. The generated client sends only query
arguments; credentials are acquired after server authorization and sent privately
to the trusted module worker. Additional action names, OAuth auth and unsupported
Activepieces context capabilities are refused.

**Inherited PostHog proof: real provider calls are zero.** Real storage/crypto/runtime checks and a real local
HTTP socket do not turn the simulator into PostHog. No real credential was supplied.
The default source mapping names the existing US/EU PostHog Cloud hosts, but that
path has not been exercised with a real project.

## Dependency and authentication findings

- The selected community source, `pieces-common`, `pieces-framework`,
  `core/utils` and `core/piece-types` fall under upstream's
  [MIT Expat license](https://github.com/activepieces/activepieces/blob/bd21dda7613f2157d6d988dac4011eb559896c44/LICENSE),
  retained in `ACTIVEPIECES-LICENSE`. MIT permits reuse without obtaining a separate
  permission from Activepieces, subject to preserving notices. Third-party code
  retains its own licenses; see `NOTICE.md` for the audit's limits.
- Upstream excludes `packages/ee/` and `packages/server/api/src/app/ee` from MIT.
  The [enterprise license](https://github.com/activepieces/activepieces/blob/bd21dda7613f2157d6d988dac4011eb559896c44/packages/ee/LICENSE)
  requires subscription terms/a valid enterprise license for production use.
  The inspected module source dependency chain does not import those directories.
  We do not run the platform, embedding, enterprise connection management or OAuth service.
- This action needs only the customer's personal API key, project id and API host.
  No OAuth client, provider app registration, redirect URL, review, vendor contact
  or paid connector subscription was used. Provider API access/quotas are separate.
  [PostHog documents](https://posthog.com/docs/api/personal-api-keys) key creation
  in account settings, **but recommends OAuth for apps other customers connect to**.
  The technical API-key proof is not confirmation that this is PostHog's endorsed
  authentication model for a multi-customer commercial offering.
- Existing community code does not supply someone else's OAuth app rights.
  Activepieces' [hosted OAuth option](https://www.activepieces.com/docs/install/configuration/environment-variables)
  (`AP_CLOUD_AUTH_ENABLED`) is a hosted-service dependency, not used here. OAuth
  pieces can still require provider registration, scopes, verification and refresh
  handling. Those cannot be declared solved by loading modules.
- A significant bundle issue: its shared
  [HTTP helper](https://github.com/activepieces/activepieces/blob/bd21dda7613f2157d6d988dac4011eb559896c44/packages/pieces/common/src/lib/http/core/fetch-http-client.ts)
  writes `NODE_TLS_REJECT_UNAUTHORIZED=0` and logs upstream error bodies. The selected
  PostHog client separately supplies a verifying TLS dispatcher and disables
  redirects, but other pieces may not. Every import and invocation therefore runs
  in a fresh, five-second child process with an empty environment, no forwarded
  stdout/stderr, and sanitized IPC errors. The demo verifies the parent's TLS
  environment is unchanged. This is not an OS sandbox, and does not establish
  TLS or network safety for other pieces.

## Inherited PostHog proof limits

The inherited PostHog runtime proof uses an integration Patchy already supports
to keep that runtime seam small. The separate community catalog above adds
connection-page execution, not a general patch runtime integration schema. A new provider still
needs a reviewed auth-field mapping, permitted operations and credential
destinations, input/output schemas, and a connection setup/discovery experience.
Common adapter execution can stay shared instead of rewriting each API call.

This action lacks placeholder values, so the prototype rejects `values` before
HTTP. It fixes the provider query name to `activepieces`, renames duplicate result
columns, and normalizes some malformed results; this is not full semantic parity
with Patchy's native source. Rich provider errors/rate limits collapse to a safe
`source_unavailable`. Dynamic properties, OAuth/token refresh, triggers, webhooks,
files, flow state and other Activepieces context services are unimplemented.
Resource limits, cancellation, outbound network policy and a complete bundled
dependency/license inventory need review before any production adapter.

Focused demo, TypeScript and lint/format checks are the relevant checks here.
Full `pnpm verify` and live provider validation have not been run. This prototype
is not ready to ship. Migrations, wire contracts, CLI flags, generated release
assets and product vocabulary remain unchanged. The local browser app is a
published patch; first-party portal and connection pages keep their existing UI.
