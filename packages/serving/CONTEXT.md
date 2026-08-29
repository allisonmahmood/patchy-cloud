# Serving

How a published patch reaches its reader. `packages/serving` owns the serving guarantees and the headers that carry them, the page routes — the home page, the health check, a patch at its latest URL (`/d/<id>`) and at a version URL (`/d/<id>/v/<n>`), the HTML 404 for everything else — and the trusted-proxy schema that decides where a request came from. It reads through [Patches](../patches/CONTEXT.md): the record and the HTML behind it come from `Content`, the visit that keeps a patch alive goes to `Patches`, and this package never touches bytes. It is the layer the tier 1 and tier 2 runtimes will build on; today every patch is a tier 0 static page.

## Language

**Serving guarantee**:
A fixed promise about how a published patch reaches its reader, binding on every served response. There are four, and they hold together: pages are **share-a-link-never-be-found** (`X-Robots-Tag: noindex` keeps them out of search results, and that is the only measure taken against discovery); readers are **unwatched** (no cookies, no auth or session on the serving host, a fully locked CSP with no script sources and so no analytics JavaScript); patch URLs are **open to machines** — never bot-blocked, challenged, or put behind a WAF human-check, because an agent handed a pasted link must be able to fetch it; and caching is **keyed to URL shape** — a version URL names content that can never change, so it is cached for a year and marked immutable, while the latest-patch URL follows the patch and gets a short window that lets an update land on its own. Everything else, API routes included, stays `no-store`. A cache lifetime is never coupled to a CDN purge API: the window expiring is the only invalidation there is.
_Avoid_: hardening, bot protection (the serving surface is deliberately open to machines), private (unlisted is not private)

**Page**:
A patch as a reader receives it: the uploaded document in a sandboxed frame and nothing else — no chrome, no script, no first-party link out. A page's 404 keeps the patch URL's headers (noindexed, no referrer, uncached), so an expired or unknown patch answers under the same guarantees a served one did. The home page and the 404 are first-party chrome and share one shell; the served page is deliberately not that shell.
_Avoid_: viewer (the old name), wrapper (the frame is the page)

**Trusted proxy**:
A network — an address or CIDR block in `PATCHY_TRUST_PROXY` — whose `X-Forwarded-For` is believed. The client's address is the socket's unless the socket is a trusted proxy's, in which case the chain is walked from the right and the first address outside a trusted network wins. From a direct peer the header is ignored, since anyone can write one; a list that would trust a whole address family is refused at startup, because it would let any direct peer choose its own attribution. Every per-address decision on the server keys on the resolved address.
_Avoid_: hop count (cannot verify the connecting peer, and is rejected), `X-Real-IP`
