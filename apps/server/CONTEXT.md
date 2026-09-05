# Hosting

The process that serves Patchy Cloud: wiring, and one guard. `apps/server` composes the capability packages into one Effect layer — the services over a migrated Postgres, the `/api/*` contract with both groups' handlers behind the bearer middleware, the pages, the expiry sweep forked in the same scope — and listens. What a patch is and the API group that publishes and deletes it are [Patches](../packages/patches/CONTEXT.md)'; how a page reaches its reader is [Serving](../packages/serving/CONTEXT.md)'s; who may call the API is [Auth](../packages/auth/CONTEXT.md)'s; where bytes go is [Content store](../packages/content-store/CONTEXT.md)'s. Every setting is read by the package that owns it through Effect `Config`; the server adds only `PORT` and the protected-API limit.

## Language

**API guard**:
The middleware ahead of the router on every `/api/*` request, with no unauthenticated paths yet. It spends the per-address protected-API limit and requires a token before answering malformed or unknown targets; matched routes authenticate through bearer middleware before reading the body, so unauthenticated callers cannot map the API by status codes.
_Avoid_: firewall, auth middleware (that is the bearer middleware, which the guard sits ahead of)

**Protected-API limit**:
Attempts admitted per source address per minute across every guarded `/api/*` request, whatever it answers — `PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE`, spent before the token is checked and keyed on the address the trusted-proxy walk resolved. In memory, so a restart empties it.
_Avoid_: global rate limit (pages are never limited)
