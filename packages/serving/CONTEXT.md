# Serving

How a published patch reaches its reader. `packages/serving` owns the serving guarantees and the headers that carry them, the page routes — the home page, the health check, a patch at its latest URL (`/d/<id>`) and at a version URL (`/d/<id>/v/<n>`), the HTML 404 for everything else — and the trusted-proxy schema that decides where a request came from. It reads through [Patches](../patches/CONTEXT.md): metadata is authorized before `Content` reads the HTML, and the visit that keeps a patch alive goes to `Patches`. A private patch's storage faults reveal nothing to a reader who cannot open it. It is the layer the tier 1 and tier 2 runtimes will build on; today every patch is a tier 0 static page. Because a runtime is where a patch meets its viewer, the identity patch code acts as (_viewer_, _patch identity_) and the doors in front of a page live here too. When the tier 1 and tier 2 runtimes are built, split them out of this context into a Runtimes context of their own and leave Serving the tier 0 path; until then a codeless Runtimes glossary would describe nothing.

## Language

**Serving guarantee**:
A fixed promise about how a published patch reaches its reader: pages are **share-a-link-never-be-found** (kept out of search results, with no other measure against discovery); readers are **unwatched by the patch** (the patch runs no script; a company page's shell runs only Patchy's own session script, never analytics); patch URLs are **open to machines** that may open them, never bot-blocked or challenged; and caching is **keyed to sharing**, a minute at most for a public page and never for a doored one, at both latest and version URLs. Access checks belong to the host, not the patch, and public cache windows expire without relying on a CDN purge.
_Avoid_: bot protection (authorized agents may open pages), unlisted as a synonym for private (sharing scope controls access)

**Page**:
A patch as a reader receives it: the uploaded document in a script-free sandboxed frame, with no chrome or first-party link out. A public page's shell runs no script; a company page's shell keeps the reader's session fresh without giving the patch access to it.
_Avoid_: viewer (the [Patches](../patches/CONTEXT.md) word for the person with a patch open, who from tier 1 up is acted for; a tier 0 page has a reader because it acts for no one), wrapper (the frame is the page)

**Trusted proxy**:
A network — an address or CIDR block in `PATCHY_TRUST_PROXY` — whose `X-Forwarded-For` is believed. The client's address is the socket's unless the socket is a trusted proxy's, in which case the chain is walked from the right and the first address outside a trusted network wins. From a direct peer the header is ignored, since anyone can write one; a list that would trust a whole address family is refused at startup, because it would let any direct peer choose its own attribution. Every per-address decision on the server keys on the resolved address.
_Avoid_: hop count (cannot verify the connecting peer, and is rejected), `X-Real-IP`

**Login door**:
The moment in front of a company page that admits an active colleague, asks a signed-out reader to sign in once and return to the patch, or shows the same "no such patch" to a reader from another company as to a missing link. Someone signed in but not yet enrolled goes through create-or-join first, a deactivated user sees the deactivated page, and request access waits until owner-only sharing returns.
_Avoid_: auth wall, login page (the door is a moment on the way to the patch, not a destination), paywall

**Connect door**:
The login door's twin for a personal connection: a viewer opening a patch that declares one they have not made is walked through connecting it, then lands on the patch. Patch code is written against the promise that every declared connection is present, so the door is what keeps that promise; a connection withdrawn mid-flight fails as the viewer's access, and the door reappears on the next open. (Not yet in the code: arrives with the integration layer.)
_Avoid_: consent screen (there is no per-patch consent), OAuth prompt (one thing that may happen behind it)

**Viewer**:
The person who has a patch open. From tier 1 up, patch code acts as the viewer and never as more: it learns who they are as claims and reaches primitives — the patch's own, and the company's connections — only through the cloud, within the viewer's own permissions. An anonymous viewer of a public patch carries no identity, so nothing acts as them.
_Avoid_: reader (a tier 0 word: the page cannot act for anyone), user (ambiguous with the builder), end user

**Patch identity**:
The principal a tier 2 patch's server side runs as when it reaches the patch's own primitives — distinct from any viewer, accountable to the patch's owner and reassignable with it, starting with nothing but the patch's own primitives and gaining a shared integration only when a company admin grants one. It never holds a raw credential; nothing at any tier does.
_Avoid_: service account (the shape, not the term), the owner's token (the patch does not inherit the owner's reach)
