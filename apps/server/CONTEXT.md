# Hosting

The process that brings Patchy Cloud's capabilities together: the API guard, protected API routes, first-party and patch pages, and the expiry sweep. Company membership belongs to [Companies](../../packages/companies/CONTEXT.md), caller identity to [Auth](../../packages/auth/CONTEXT.md), patch ownership and retention to [Patches](../../packages/patches/CONTEXT.md), and page admission and guarantees to [Serving](../../packages/serving/CONTEXT.md).

## Language

**API guard**:
The boundary ahead of every API route: protected requests require a valid machine token before revealing malformed or unknown targets. Only starting and polling a device login are admitted without one; their limits are separate from protected requests.
_Avoid_: firewall, auth middleware (that is the bearer middleware, which the guard sits ahead of)

**Protected-API limit**:
The per-address ceiling on attempts against protected API routes, including attempts refused later. It uses the client's address established by the trusted-proxy boundary, not an untrusted forwarded claim.
_Avoid_: global rate limit (device login has separate limits)
