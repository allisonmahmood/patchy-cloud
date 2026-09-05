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
shell around it is Patchy's own document. A doored patch's shell loads
Clerk's headless frontend script from the instance's Frontend API host and
Patchy's same-origin external initializer. The same pair keeps first-party
pages fresh. The server calls `authenticateRequest` and verifies the session
locally against Clerk's public key, using the handshake for a browser that
returns cold. `CLERK_JWT_KEY` supplies that public key without a JWKS fetch;
without it, the SDK retrieves Clerk's signing keys. A failed returning handshake
shows a sign-in failure rather than starting a loop.

## Consequences

**Two content-security policies.** A public patch keeps the fully locked CSP
and loads no session scripts. A doored patch's shell allows the external
initializer from its own origin and Clerk script/connect sources from the
Frontend API host, never inline script; the frame's sandbox is unchanged.
The serving guarantee reads: the patch runs no script; the shell runs only
Patchy's own session script, never analytics.

**Revocation reach is asymmetric, and honest.** Anything Patchy decides — a user
deactivated, sharing changed, a patch gone — is checked on the next origin load.
A still-fresh public response can outlive a sharing change for its one-minute
cache window. Anything Clerk decides — a session revoked in the dashboard,
a sign-out elsewhere — reaches verification within 65 seconds plus the next load.

**Reading a doored patch needs Clerk once a minute, in the browser, not on the
server.** The server verifies with a public key; the browser's refresh goes to
the Frontend API. A doored response is per-viewer and may carry `Set-Cookie`,
so it is `private, no-store`. Caching is keyed to sharing: public patches use
`public, max-age=60` at both latest and version URLs, so a scope change can
take a page back inside within a minute without a CDN purge.

**Sign-out is a browser operation, not a machine logout.** `POST /logout` needs
only a Clerk session, so it works before create-or-join and after deactivation.
It revokes that session through the Backend API, clears Clerk cookies with
their setting domain and path, and returns to `/login`. First-party POSTs
require the public origin or same-origin fetch metadata, including sign-out.

**Required configuration fails at startup.** Clerk's publishable and secret
keys, `PATCHY_PUBLIC_BASE_URL` and `DATABASE_URL` are required. The optional
public JWT key is validated at startup too; there is no partially configured
server mode.

## Alternatives considered

- **A Patchy session cookie minted at the door.** Rejected: a second session
  concept and table, working around a problem that only existed because the
  shell was held to the patch's rule, and Clerk's session management (its
  dashboard, lifetime and inactivity settings, abuse prevention at sign-in) is
  what Clerk is for.
- **The server refreshes the token on a script-free shell.** Proven to work on
  the prototype, rejected for the cost above and for depending on the SDK's
  cookie naming on a path it was not built for.
