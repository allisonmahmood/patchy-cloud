# Serving

How a published patch reaches its reader. `packages/serving` owns the serving guarantees and the headers that carry them, the page routes — the home page, the health check, a patch at its latest URL (`/d/<id>`) and at a version URL (`/d/<id>/v/<n>`), the HTML 404 for everything else — and the trusted-proxy schema that decides where a request came from. It reads through [Patches](../patches/CONTEXT.md): the record and the HTML behind it come from `Content`, the visit that keeps a patch alive goes to `Patches`, and this package never touches bytes. It is the layer the tier 1 and tier 2 runtimes will build on; today every patch is a tier 0 static page. Because a runtime is where a patch meets its viewer, the identity patch code acts as (_viewer_, _patch identity_) and the doors in front of a page live here too. When the tier 1 and tier 2 runtimes are built, split them out of this context into a Runtimes context of their own and leave Serving the tier 0 path; until then a codeless Runtimes glossary would describe nothing.

## Language

**Serving guarantee**:
A fixed promise about how a published patch reaches its reader, binding on every served response. There are four, and they hold together: pages are **share-a-link-never-be-found** (`X-Robots-Tag: noindex` keeps them out of search results, and that is the only measure taken against discovery); readers are **unwatched** (no cookies, no auth or session on the serving host, a fully locked CSP with no script sources and so no analytics JavaScript); patch URLs are **open to machines** — never bot-blocked, challenged, or put behind a WAF human-check, because an agent handed a pasted link must be able to fetch it; and caching is **keyed to URL shape** — a version URL names content that can never change, so it is cached for a year and marked immutable, while the latest-patch URL follows the patch and gets a short window that lets an update land on its own. Everything else, API routes included, stays `no-store`. A cache lifetime is never coupled to a CDN purge API: the window expiring is the only invalidation there is. Decided on [Runtime tiers](https://github.com/allisonmahmood/patchy-cloud/issues/17): once auth lands the host checks who opened a page in order to let them in, so _unwatched_ narrows to _the page cannot watch you_ and _open to machines_ to any agent that may open it; the script-free page and URL-shaped caching stay as tier 0's guarantees.
_Avoid_: hardening, bot protection (the serving surface is deliberately open to machines), private (unlisted is not private)

**Page**:
A patch as a reader receives it: the uploaded document in a sandboxed frame and nothing else — no chrome, no script, no first-party link out. A page's 404 keeps the patch URL's headers (noindexed, no referrer, uncached), so an expired or unknown patch answers under the same guarantees a served one did. The home page and the 404 are first-party chrome and share one shell; the served page is deliberately not that shell.
_Avoid_: viewer (the [Patches](../patches/CONTEXT.md) word for the person with a patch open, who from tier 1 up is acted for; a tier 0 page has a reader because it acts for no one), wrapper (the frame is the page)

**Trusted proxy**:
A network — an address or CIDR block in `PATCHY_TRUST_PROXY` — whose `X-Forwarded-For` is believed. The client's address is the socket's unless the socket is a trusted proxy's, in which case the chain is walked from the right and the first address outside a trusted network wins. From a direct peer the header is ignored, since anyone can write one; a list that would trust a whole address family is refused at startup, because it would let any direct peer choose its own attribution. Every per-address decision on the server keys on the resolved address.
_Avoid_: hop count (cannot verify the connecting peer, and is rejected), `X-Real-IP`

**Login door**:
What a link opened without a session shows, at every tier: sign in once, land back on the patch. It sits in front of the page, never inside it, and it is where the host learns who opened a page in order to let them in — the one place _unwatched_ narrows. Not signed in sees the door; signed in but outside the patch's scope sees who owns it and _request access_; another company, or no such patch, sees "no such patch" and nothing more. (Not yet in the code: arrives with auth.)
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
