# Plain iframe sign-in experiment (#1232)

This is an isolated feasibility prototype for #1111, not production authentication.
Nothing in this directory is imported by the product server or its release build.

Run `pnpm exec playwright install chromium firefox`, then `pnpm prototype:embed`.
The runner reads only the development Clerk key pair from the developer's
`patchy-cloud/dev.env` (see `docs/DEVELOPMENT.md`, Signing in with Clerk).
It refuses live keys. It creates three run-scoped `+clerk_test@example.com`
people, a disposable local database/server, and two loopback host pages.
It sends no invitations. Teardown deletes the test users and local state.

The browser checks use real Account Portal email/code sign-in. Chromium uses
an attached DevTools session's `Network.setCookieControls` restriction as well
as the phaseout flag; Firefox rejects third-party cookies. Each
checks that an unpartitioned `SameSite=None; Secure` probe cookie, set in the
first-party tab, is unavailable inside the embed. Never enable authentication
traces or context-wide video: those can capture Clerk credentials.

`results.json` and host-only screenshots go under `.local/embed-prototype/`.
The runner prints only named checks, timing and credential-free counters.

## Mechanism under test

1. A plain iframe loads a Patchy-controlled door on an approved exact origin.
   The frame holds a random verifier; the server holds its SHA-256 challenge.
2. A click opens normal Patchy/Clerk sign-in in a new tab, with no opener.
   The handoff id in that URL cannot claim a session without the verifier.
3. The person confirms the host. Patchy checks the real Clerk session and the
   existing patch door, including existing outside-guest grants.
4. The original frame claims a random credential using the verifier in a POST.
   It keeps the credential in memory. The host gets no messages or credential.
5. The prototype ingress maps that credential to the same live Clerk session,
   patch and host, then forwards requests through the existing serving/runtime
   doors. Short Clerk JWTs are refreshed server-side for that same session;
   they never enter the host, patch code or a URL.
6. The original broker is bundled with a loader substitution: a form POST
   loads the original content URL with the credential in its body. The
   response retains the HTTP sandbox/CSP and the original content, nonce and
   broker protocol. A second substitution keeps stopping notices in the embed
   door instead of navigating to a normal, non-frameable Patchy notice.
   Runtime fetches carry the credential in a header.

The embedded session lasts five minutes. It is not renewed. Reload loses the
frame's credential and requires another sign-in click; an existing first-party
Clerk session can satisfy that click without retyping a code. Ending one embed
does not sign out of Patchy. Normal Patchy sign-out invalidates its embeds.
`/~prototype/sessions` is a first-party, authenticated test read/revoke control.

The ingress checks session status, host approval and actual patch access on
each request and every second for open sessions. A failed check fences future
requests and cancels streams; the frame also checks every second and removes
its content on failure. Already displayed data and in-flight operations are
not erased or rolled back. The browser report measures observed timing.

Public patches use the existing public shell/runtime, with both ancestor
policies widened in this ingress only. The same fixture checks anonymous
identity and refusal of owned-table writes on either host.

## Limits

The company host list is an in-memory test setting. There are no settings,
roles, host SDK, catalogue, embed-specific patch format or workflow changes.
The ingress uses a Clerk backend check and a patch-door read per recheck;
its cost and ordering are deliberately unoptimized. It is not a deployable
auth service. The expiry check uses a four-second configured lifetime to avoid
waiting five minutes; it does not replace Clerk authentication or the clock.

Removing an iframe closes that view. Its unused embedded session remains
visible in the first-party control until it is ended or expires. Restarting
the prototype loses all embedded sessions. Browser crashes, suspended tabs,
network delays and production-scale revocation are not established by a local
run. Issue #1232 and its PR hold the observed results and remaining blockers.
