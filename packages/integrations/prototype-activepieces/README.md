# Activepieces module prototype

Local, throwaway milestone 1. `prototype/activepieces-slack-token` starts from
the pushed `prototype/activepieces` and is rebased onto main at `8a278cb4`.
This directory is outside the
integration package's production `src`. A separate local server entrypoint
composes the adapter; normal server startup, releases, migrations and the SDK
keep their existing behavior. No Nango branch code was incorporated.

The question: can a shared adapter run an existing community action while
Patchy owns connections, secrets and authorization? **Yes for this one action,
against simulated provider responses.** This does not prove catalog compatibility
or a successful real provider call. The Slack mode below is wired for real
requests, but needs your existing bot token to demonstrate provider success.

## Slack inside local Patchy

```sh
npm --prefix packages/integrations/prototype-activepieces ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/integrations/prototype-activepieces run local:slack
```

Open the printed Customer A link. You are inside Patchy's signed-in Connections
area. Paste an **existing installed app's `xoxb-` bot token**, then choose
**Test and connect**. This runs the module's existing `auth.test` validator.
Choose **List public channels** to run its unchanged `slack_list_channels`
action, limited to `public_channel` and excluding archived channels. The bot
needs `channels:read`. No Slack app is registered and no OAuth redirect occurs.
No messages are sent. Do not paste a token into chat, a source file or a URL.

The normal Connections page links to this local Slack page. Replace token,
disconnect (which erases the saved token), reconnect, delete a disconnected
connection, and recent call outcomes are available there. The two test companies
start with **no Slack connections**. Use Customer B's link in another browser
profile and a separate token to try a second real connection. With one browser
profile, the latest sign-in changes every tab to that company.

This mode uses **real Slack requests**; it never substitutes fake successful
responses. The automated `slack.test.ts` is different: it loads the same pinned
module but redirects its HTTP transport to a loopback **mock Slack provider**.
It verifies two companies' credential selection, rejected cross-company ids,
admin checks, same-origin checks, encryption, safe failures and call logs. These
tests do **not** establish that a real Slack workspace has connected.

The adapter selects `CUSTOM_AUTH` explicitly from the piece's OAuth/custom-auth
array, runs its validator, and maps the saved token into the existing action's
`{ type: "CUSTOM_AUTH", props: { botToken } }` auth shape. The worker keeps TLS
certificate validation enabled despite an upstream helper's attempt to disable
it. Tokens travel over private IPC, not process arguments or environment.

The local service reuses the existing `connections` table under integration
`activepieces:slack`, AES-GCM `CredentialKeys` (including company/id/integration
binding), `RequireSession` membership/admin checks and `RuntimeLog`. Native
stores already filter unknown integration kinds. No migrations, production
entrypoint, public API schema, CLI or SDK contract are changed. Saved tokens
are never returned in HTML, action output or call logs. Calls run as an admin
from the connection page; **Slack is not yet callable from generated patch
clients or declared patch runtime operations**. That runtime contract remains a
separate milestone; the inherited PostHog mock demonstrates those surfaces only
for PostHog. This proof does not create schema snapshots for community actions.

Provider-specific work still includes auth shape/field mapping, scopes, admitted
actions and properties, result schemas, timeouts/pagination, rate limits and
any additional Activepieces context capabilities. OAuth, triggers, webhooks,
background execution and general catalog discovery are outside this milestone.
One connector's compatibility says nothing about the rest of the catalog.

**Permission boundary:** an authorized local/internal test with an existing
token does not need Patchy to register a provider app or use a hosted auth broker.
The token still carries the Slack app's existing permissions and any workspace
admin restrictions. It is not a workaround for Slack's commercial distribution
rules: [Slack's API terms](https://slack.com/terms-of-service/api), effective
October 10, 2025, require a separate agreement for commercial distribution,
including apps connecting to paid products and custom app templates (with a
single-third-party exception). Do not treat this prototype as clearance to ship
a commercial Slack integration without resolving that blocker.

To switch modes, stop this worktree's instance first with `local:stop`, then run
`local:slack` for real Slack or `local` for the inherited PostHog mock below.
State survives restart; `pnpm dev down` deletes this worktree's local instance.

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

**Real provider calls: zero.** Real storage/crypto/runtime checks and a real local
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

## What still needs work

This uses an integration Patchy already supports to keep the seam small; it does
not add a new catalog entry or general connection schema. A new provider still
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
