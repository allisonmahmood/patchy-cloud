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

## Useful workflow (#1233)

Run `pnpm prototype:embed-workflow` to review a real sample quote and approve its
spend request inside the same local host fixture. This uses the existing tier 2
Spend Requests scenario without changing its UI, handlers or declarations. The
released local CLI initializes, refreshes and publishes it into the disposable
instance; the scenario's own Load sample data action creates the requests and files.
The manager and teammate are test people, and no host data is connected.

The host is a local fixture of an editable team operations app, using the plain
URL-based iframe slot available in an
[Appsmith fixed-layout app](https://docs.appsmith.com/reference/widgets/iframe).
This is a plain iframe demonstration, not a run of Appsmith itself or a claim
that every host's CSP and sandbox settings permit it. The fixture reuses #1232's
900 × 600 frame; the workflow also tries it at 520px wide.

The flow is:

```text
Team app → Spend Requests iframe → Sign in to Patchy in a new tab
         ← return to original frame ← normal Clerk sign-in + confirmation
         → open request → review quote → approve → live update in Patchy
```

### Minimal installation contract

1. Choose one published patch and an editable slot in the host app. The host
   must allow framing Patchy and the viewer's click must be allowed to open a
   separate sign-in tab. Keep Patchy's inner sandbox and broker intact.
2. For a private patch, a super admin approves the **exact host origin** at the
   company level; this experiment uses `proxy.approved`, never a live setting.
   Each viewer still needs their existing access to the patch. The host's login
   does not grant that access.
3. In this local experiment, mount the prototype's Patchy-controlled door:

   ```html
   <iframe
     title="Spend Requests"
     src="PATCHY_ORIGIN/~prototype/embed?host=ENCODED_HOST_ORIGIN&amp;patch=PATCH_ID"
     width="900"
     height="600"
   ></iframe>
   ```

   Replace the placeholders with the local origins and patch id created by
   the runner; encode the host origin as a query value. The `host` parameter is
   configuration, not proof: CSP checks the actual ancestors. The host receives
   no credentials, identities, catalogue, data or messages. In an Appsmith
   fixed-layout Iframe widget, the same address goes in **URL**, with **srcDoc**
   empty. Actual host policies still need testing before installation there.

4. The host owns the width, height and position. The patch keeps its existing
   scrolling and UI. **Open in Patchy** offers more space.

The route above and its query format are only the #1232 experiment, not a
new production embed API. No installation works against the released product
until the prototype's framing/auth work is implemented there.

### Evidence and limits

The runner checks real development Clerk sign-in with third-party cookies
unavailable in Chromium and Firefox, keyboard approval, stored quote preview
and download, the same decision arriving live in a full-page view, the narrower
frame, normal publish/rollback and retirement. The patch has no client route
needed for this task; opening/closing its existing drawer must leave the host
URL in place. Publish and rollback use the existing version notification and
reload behavior, including another sign-in click after an embedded reload.

Host-only stills, downloaded test quotes and `results.json` are written under
`.local/embed-workflow/`. Authentication pages are never captured. As in #1232,
teardown deletes the exact run-scoped Clerk test users and local instance. The
five-minute session, no renewal and process-local state remain experimental
defaults. This workflow does not settle production auth policy or prove a
customer deployment. The issue and stacked PR hold the observed result and gaps.
