# Activepieces module prototype

Local, throwaway milestone 1, based on Patchy main at
`e4243ff54d2acbbc88b60eeb0cf9b82a26dc9d5d`. This directory is outside the
integration package's production `src`. A separate local server entrypoint
composes the adapter; normal server startup, releases, migrations and the SDK
keep their existing behavior. No Nango branch code was incorporated.

The question: can a shared adapter run an existing community action while
Patchy owns connections, secrets and authorization? **Yes for this one action,
against simulated provider responses.** This does not prove catalog compatibility
or a successful real PostHog call.

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

## Try it in a browser

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
