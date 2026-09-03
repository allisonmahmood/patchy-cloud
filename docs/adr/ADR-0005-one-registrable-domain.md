# ADR-0005 — Pages, API and Account Portal share one registrable domain

- **Status**: Accepted
- **Date**: 2026-09-03
- **Contexts**: Serving (`packages/serving`, the login door), Auth (`packages/auth`, the session) — and the deployment, which is where the constraint bites, so it lives in the root ADR home.
- **Source**: [The login door on a tier 0 page](https://github.com/allisonmahmood/patchy-cloud/issues/120) question 6, on the evidence of [Clerk on a server with no frontend](https://github.com/allisonmahmood/patchy-cloud/issues/113) and [the login door end to end](https://github.com/allisonmahmood/patchy-cloud/issues/119).

## Context

Clerk holds the browser session (ADR-0006). It rides on two cookies: `__client_uat`,
set on the registrable domain, which tells the server a Clerk client exists in
this browser; and `__session`, host-only, the short-lived token itself. A
browser that comes back to a page after the token expired is signed in again by
the **handshake**: a redirect chain from the page to Clerk's Frontend API and
back, which works only when the page's host can see `__client_uat`. In
production the Frontend API is a CNAME `clerk.<domain>` and the Account Portal is
`accounts.<domain>`, both under the instance's domain.

## Decision

Patchy Cloud's pages (`/d/*` and the first-party pages), its API and its Clerk
Account Portal are served under **one registrable domain**. The production
Clerk instance is created for that domain, and the deployment chooses it before
the instance exists.

Within that domain the layout is free. Clerk shares a session across subdomains
by default: each host completes the handshake once for its own `__session`, so a
per-company subdomain later needs nothing from Clerk beyond an
`authorizedParties` entry per host. Local development is unaffected: a
development instance signs `localhost` in, and `pnpm dev` runs one server per
worktree on its own port.

## Consequences

**The domain is deployment's first decision.** The production Clerk instance,
its CNAMEs and the OAuth consent screens all hang off it, and moving it later
means a new instance and every user signing in again.

**A customer's own domain is a separate feature.** `patchy.acme.com` is a Clerk
_satellite domain_: free in development, a paid plan in production, and sign-in
must still happen on the primary. It is not designed; when a company asks, it is
a pricing question before it is a build.

**The door trusts no proxy for its own origin.** Because the handshake's return
URL is derived from the request's host headers, the door builds the request it
hands Clerk from `PATCHY_PUBLIC_BASE_URL`, which loses its `localhost` default:
a server that cannot name its own origin does not start.

## Alternatives considered

- **Separate domains for pages and the portal, bridged by satellite domains.**
  Rejected: paid, sign-in confined to the primary, and nothing today needs it.
- **A Patchy session cookie, so only sign-in touches Clerk's cookies.**
  Rejected with ADR-0006; the handshake would still need the shared domain at
  the door.
