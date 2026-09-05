# Serving

How a published patch reaches its reader: the page, admission at its login door and the serving guarantees. Patch content and visits belong to [Patches](../patches/CONTEXT.md), the session and viewer to [Auth](../auth/CONTEXT.md); future runtime and connection-door decisions live in [the product](../../docs/product.md#runtime-tiers).

## Language

**Serving guarantee**:
A fixed promise about how a published patch reaches its reader: pages are **share-a-link-never-be-found** (kept out of search results, with no other measure against discovery); readers are **unwatched by the patch** (the patch runs no script; a company page's shell runs only Patchy's own session script, never analytics); patch URLs are **open to machines** that may open them, never bot-blocked or challenged; and caching is **keyed to sharing**, a minute at most for a public page and never for a doored one, at both latest and version URLs. Access checks belong to the host, not the patch, and public cache windows expire without relying on a CDN purge.
_Avoid_: bot protection (authorized agents may open pages), privacy (the host checks access; the guarantee is that the patch cannot watch its reader)

**Page**:
A patch as a reader receives it: the uploaded document in a script-free sandboxed frame, with no chrome or first-party link out. A public page's shell runs no script; a company page's shell keeps the reader's session fresh without giving the patch access to it.
_Avoid_: viewer (the [Auth](../auth/CONTEXT.md) identity, not the page), wrapper (the frame and its surrounding shell together make the page)

**Trusted proxy**:
A network whose forwarded client address the host trusts when attributing requests. An untrusted direct peer speaks only for its own address, never for an address it supplied in a header.
_Avoid_: hop count (cannot verify the connecting peer, and is rejected), `X-Real-IP`

**Login door**:
The admission in front of a company patch: an active colleague enters, a signed-out reader signs in and returns, and a reader from another company gets the same absence as a missing link. A signed-in person without a company first goes through create-or-join; a deactivated user sees the deactivated page.
_Avoid_: auth wall, login page (the door is a moment on the way to the patch, not a destination), paywall

**Connect door**:
The future admission in front of a patch that needs a personal connection the viewer has not made. Its connection and return behavior lives in [the product](../../docs/product.md#declaring-granting-opening).
_Avoid_: consent screen (there is no per-patch consent), OAuth prompt (one thing that may happen behind it)

**Patch identity**:
The future identity a tier 2 patch's server side uses for its own primitives, distinct from the viewer and accountable to the patch's owner. Its reach is described in [the product](../../docs/product.md#tier-2--hosted).
_Avoid_: service account (the shape, not the term), the owner's token (the patch does not inherit the owner's reach)
