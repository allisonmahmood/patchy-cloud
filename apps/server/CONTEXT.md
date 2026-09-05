# Hosting

The process that serves Patchy Cloud: wiring, and one guard. `apps/server` composes the capability packages into one Effect layer — the services over a migrated Postgres, the `/api/*` contract with both groups' handlers behind the bearer middleware, the pages, the expiry sweep forked in the same scope — and listens. What a patch is and the API group that publishes and deletes it are [Patches](../packages/patches/CONTEXT.md)'; how a page reaches its reader is [Serving](../packages/serving/CONTEXT.md)'s; who may call the API is [Auth](../packages/auth/CONTEXT.md)'s; where bytes go is [Content store](../packages/content-store/CONTEXT.md)'s. Every setting is read by the package that owns it through Effect `Config`; the server adds only `PORT` and the protected-API limit.

## Language

**API guard**:
The middleware ahead of the router on every `/api/*` request but the self-service mint. It spends one attempt of the per-address protected-API limit, then — for the shapes the router never sees, a malformed target or an overlong patch id, and for every target the router has no handler for — requires a token before it answers 400, 414 or 404. A route the router matches authenticates through the API's own bearer middleware, before its body is read. The guard exists so a caller with no token cannot map the API by its status codes and a flood of them runs into the limit like any other; it is not authorization, which every handler decides for itself.
_Avoid_: firewall, auth middleware (that is the bearer middleware, which the guard sits ahead of)

**Protected-API limit**:
Attempts admitted per source address per minute across every guarded `/api/*` request, whatever it answers — `PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE`, spent before the token is checked, keyed on the address the trusted-proxy walk resolved. In memory, so a restart empties it. The mint has its own per-address limit in Auth and is not counted here.
_Avoid_: global rate limit (pages are never limited)
