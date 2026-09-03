# ADR-0006 — Clerk holds the browser session, and the shell keeps it fresh

- **Status**: Accepted
- **Date**: 2026-09-03
- **Contexts**: Auth (`packages/auth`, the session), Serving (`packages/serving`, the login door and the served page's shell).
- **Source**: [The login door on a tier 0 page](https://github.com/allisonmahmood/patchy-cloud/issues/120) questions 1, 8 and 9, on the evidence of [the login door end to end](https://github.com/allisonmahmood/patchy-cloud/issues/119).

## Context

`docs/product.md` decided that Clerk holds who a person is and their browser
session, and that Patchy holds the company, access and the machine token. Clerk's
session token lives 60 seconds. In an ordinary Clerk app the frontend SDK
refreshes it every 50 seconds in the browser and the server only verifies the
signature; the handshake (a redirect chain through Clerk's Frontend API) signs
a browser back in when it returns cold.

A tier 0 patch runs no script. The door prototype held Patchy's shell around the
patch to the same rule, so the _server_ refreshed the token instead: a Clerk
round trip per reader roughly once a minute, a workaround for how
`@clerk/backend` names its refreshed cookie on a script-free page, and reading a
patch after a minute idle depending on `api.clerk.com`. That cost made a Patchy
session cookie, minted once at the door, look attractive: no refresh machinery,
revocation owned outright, at the price of a second session concept and a
`sessions` table.

## Decision

**Clerk holds the browser session. Patchy issues one credential, the machine
token.** There is no Patchy session cookie and no session table.

The no-script guarantee is the **patch's**, inside its sandboxed frame; the
shell around it is Patchy's own document. So a doored patch's shell loads
Clerk's headless frontend script from the instance's Frontend API host, which
refreshes the token and sets the cookies exactly as in any Clerk app. The server
does what a Clerk backend normally does: `authenticateRequest` on every doored
load, verified locally against the instance's public key, with the handshake
for a browser that comes back cold. No server-side refresh, no cookie
workaround, no SDK pin.

## Consequences

**Two content-security policies.** A public patch keeps the fully locked CSP
and loads nothing. A doored patch's shell allows script and connect sources for
the Frontend API host, no inline script; the frame's sandbox is unchanged. The
serving guarantee reads: the patch runs no script; the shell runs only Patchy's
own session script, never analytics.

**Revocation reach is asymmetric, and honest.** Anything Patchy decides — a user
removed, a scope changed, a patch gone — lands on the next load, through the
user read the door already does. Anything Clerk decides — a session revoked in
the dashboard, a sign-out elsewhere — lands within 65 seconds plus the next
load.

**Reading a doored patch needs Clerk once a minute, in the browser, not on the
server.** The server verifies with a public key; the browser's refresh goes to
the Frontend API. A doored response is per-viewer and may carry `Set-Cookie`,
so it is `private, no-store`; caching stays URL-shaped only for public patches.

**Clerk's keys are required configuration.** The server refuses to start
without them, like the bootstrap token; there is no half-up state. Sign-out is a
Patchy `POST` that revokes the Clerk session through the Backend API and clears
every Clerk cookie with the `Domain` and `Path` its setter used.

## Alternatives considered

- **A Patchy session cookie minted at the door.** Rejected: a second session
  concept and table, working around a problem that only existed because the
  shell was held to the patch's rule, and Clerk's session management (its
  dashboard, lifetime and inactivity settings, abuse prevention at sign-in) is
  what Clerk is for.
- **The server refreshes the token on a script-free shell.** Proven to work on
  the prototype, rejected for the cost above and for depending on the SDK's
  cookie naming on a path it was not built for.
