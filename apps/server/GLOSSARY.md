# Hosting

The vocabulary of Patchy Cloud's hosting boundaries. Capability ownership and package relationships are in the [context map](../../GLOSSARY-MAP.md).

## Language

**API guard**:
The boundary ahead of every API route: protected requests require a valid machine token before revealing malformed or unknown targets. Release discovery and device-login starts and polls are public; Runtime owns its browser-session admission and per-viewer limits instead of using the bearer guard.
_Avoid_: firewall, auth middleware (that is the bearer middleware, which the guard sits ahead of)

**Protected-API limit**:
The per-address ceiling on attempts against protected API routes, including attempts refused later. It uses the client's address established by the trusted-proxy boundary, not an untrusted forwarded claim.
_Avoid_: global rate limit (device login has separate limits)
