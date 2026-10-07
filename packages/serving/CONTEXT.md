# Serving

How a published patch reaches its reader: the page, admission at its login door and the serving guarantees. Patch content and visits belong to [Patches](../patches/CONTEXT.md), sessions and viewers to [Auth](../auth/CONTEXT.md), and document, stream, lifecycle and execution authority to [Runtime](../runtime/CONTEXT.md); only personal-connection doors remain future work here.

## Language

**Address**:
The human-readable location of a patch within its company, independent of tier and sharing scope. An address points to the patch's current version or a numbered version; a former name redirects only until another patch claims it.
_Avoid_: identity (the patch keeps its id), public URL (an address does not grant anonymous access)

**Content URL**:
The internal, non-redirecting location of one version's bytes, protected by the same login door and sharing rules as its address. It names that version's content and tier, not whichever version is current.
_Avoid_: address (the reader-facing location), download link, public URL

**Serving guarantee**:
The promise made about a patch at each tier: the patch cannot watch you at tier 0; on tiers 1 and 2, its browser code acts through Patchy without holding a login or credential. Tier 2 adds credential-free server handlers that reach owned resources as the patch and company data as the initiating viewer, with no direct internet access and every write logged for company admins. Pages stay out of search results, public shells load no analytics, and the shell maintains a session for company documents and authenticated directory access on public tier 1 documents.
_Avoid_: bot protection (authorized agents may open pages), unlisted as a synonym for private (sharing controls access), anonymous as a promise about company pages (the host admits the viewer)

**Page**:
A patch as a reader receives it: its document in a sandboxed frame and the surrounding shell, with first-party doors and notices belonging to Patchy rather than the patch. Tier 0 content is script-free, and a font reaches it only embedded in its own bytes; tier 1 and tier 2 content runs browser code without direct network or credential access.
_Avoid_: viewer (the [Auth](../auth/CONTEXT.md) identity, not the page), wrapper (the frame and its surrounding shell together make the page)

**Shell**:
The trusted page surrounding one loaded patch version, owning the reader's address, broker, stream and first-party lifecycle notices on tiers 1 and 2. It keeps the session fresh for company documents and authenticated public member-directory access; a historical page uses the selected version's tier.
_Avoid_: patch (the untrusted content it contains), viewer (the person opening it)

**Broker**:
The shell's gate between one patch document and Patchy. It binds requests to the loaded version and the initiating viewer, never gives patch code a credential, and never lends a replacement document the old document's authority.
_Avoid_: proxy URL (patches request operations, not arbitrary destinations), SDK (the client speaks to the broker)

**Envelope**:
One correlated request or reply between a patch document and its broker, carrying the bundle's wire version and operation data. It is a message contract, not permission to choose a patch, version or initiating viewer.
_Avoid_: transport version (there is only the runtime wire), binding (the host's trusted context)

**Route bridge**:
The agreement by which a patch chooses its local route while the shell owns the address bar and browser history. Public patches retain this browser-only capability; Patchy-reserved address segments are never patch routes.
_Avoid_: redirect (changes which page is loaded), content URL (the version's internal bytes location)

**Needs-rebuild door**:
The first-party refusal shown when a stored version's runtime wire has retired. Reopening or signing in does not repair it; its owner must rebuild and publish.
_Avoid_: release mismatch (tooling freshness, not a deployed wire), session expiry

**Trusted proxy**:
A network whose forwarded client address the host trusts when attributing requests. An untrusted direct peer speaks only for its own address, never for an address it supplied in a header.
_Avoid_: hop count (cannot verify the connecting peer, and is rejected), `X-Real-IP`

**Address notice**:
The first-party page at the address, numbered version URLs and content URL of a retired or deleted patch: it tells an active colleague who took the patch off and when, and the time left to recover a deletion. It offers Restore to the owner or an admin and links to the card; signed-out readers keep the login door, while foreign, disabled and gone patches remain absent.
_Avoid_: 404 (the answer for a gone or foreign patch), door (a notice admits nothing), tombstone

**Login door**:
The admission in front of a retained company patch and the signed-out root: an active colleague enters, a signed-out reader signs in and returns, and a reader from another company gets the same absence as a missing patch. A missing, disabled or reclaimed patch has no door, so a signed-out reader can distinguish a retained address from an absent one, but cannot read its content. A signed-in person without a company first goes through create-or-join; a deactivated user sees the deactivated page.
_Avoid_: auth wall, login page (the door is a moment on the way to the patch, not a destination), paywall

**Connect door**:
The future admission in front of a patch that needs a personal connection the viewer has not made, distinct from today's admin-managed company connection pages. Its connection and return behavior lives in [the product](../../docs/product.md#declaring-granting-opening).
_Avoid_: consent screen (there is no per-patch consent), OAuth prompt (one thing that may happen behind it)
