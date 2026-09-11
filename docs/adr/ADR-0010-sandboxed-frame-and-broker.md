# ADR-0010: A sandboxed frame and a document-bound broker

Tier 1 patches run untrusted browser code on the same host as their human-readable addresses. They run in an opaque-origin frame, not in Patchy's authenticated document. A trusted shell binds one patch and version and brokers named operations as the reader; patch code never receives a session or integration credential. This keeps one address and one login door without granting uploaded script the host's authority.

Running uploaded script directly in the shell would grant same-origin session and
platform access. A separate subdomain would add host routing and login coordination
without removing the need for a trusted broker. The opaque-origin sandbox supplies
the isolation while keeping one host and the existing address/login model.

The decision implements [SDK spec §10](https://github.com/allisonmahmood/patchy-cloud/issues/193) and [issue #205](https://github.com/allisonmahmood/patchy-cloud/issues/205), following the [frame prototype](https://github.com/allisonmahmood/patchy-cloud/pull/185). Tier 0 retains its escaped `srcdoc` and empty sandbox. Tier 1 uses `/~content/<patchId>/<versionId>?n=<nonce>` and `sandbox="allow-scripts allow-modals"`. Historical pages use their selected version's tier. Content has the same door and sharing-based cache policy as its address.

## Containment and authority

The content response's CSP is `sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'`. Permissions-Policy denies camera, microphone and geolocation. The shell's `frame-src 'self'` contains script-initiated navigation and redirect egress; the iframe and HTTP sandbox must both grant a capability. Runtime file retrieval remains an attachment with a script-free sandbox CSP, never an executable uploaded document on the host.

The shell installs its load handler before navigating the frame. It transfers one MessageChannel to that document, with the URL nonce echoed in `ready { wire, nonce }`. A second load closes the port. Replies use the port, never the frame's WindowProxy, so a replacement document inherits neither pending replies nor authority. Bootstrap is bounded. There is no retry of an operation whose result was lost.

The envelope is `{ v, id, op, args, bytes? }`; replies are `{ v, id, kind: "result" | "error", value | error, bytes? }`. The bundle declares the wire, not a separate transport version. Own-property dispatch and the API operation schemas validate requests before forwarding; the server independently admits them. The broker binds ids and principal, sends the two `X-Patchy-*` headers and same-origin credentials, and carries files over bytes routes with ArrayBuffer transfers. Per-operation limits, 32 outstanding requests and 64 MiB held bytes bound a frame's work.

The first runtime call is `me` with a null principal; its user id is pinned for later calls. Public `me` is null and public company-data operations fail even for signed-in readers. A changed or expired session stops the patch and asks for sign-in followed by a whole-page reload. Access loss is a first-party notice without a reload offer; validation errors belong to patch code. Already-admitted work retains its original attribution; a missing reply remains an unknown outcome.

## Browser-owned behavior and compatibility

The route bridge keeps history in the shell, refuses Patchy-reserved segments, and notifies the document on back/forward. File images use frame-local blob URLs. Downloads are owned by the shell. Popups, external links, direct fetches, client storage, workers and device access are not patch capabilities. Printing remains available through `allow-modals`.

The scripted frame delegates `clipboard-write *` because its origin is opaque,
without delegating clipboard read. Copying is user-triggered and has a visible
failure path. Chromium can still deny the async clipboard API for that origin;
a user-triggered copy event is the compatibility path. Both engines are checked
by copying and pasting the actual text, not just observing a resolved promise.

An old shell with a supported bundle gets one cache-bypassing refresh. A repeated mismatch stops visibly rather than looping. A stored version whose wire has retired gets the first-party needs-rebuild door; a tooling release change alone never retires a deployed bundle.

`@patchy/serving/shell` exports rendering, the prebuilt broker script and CSP constants without Auth or platform infrastructure, so the local runtime can serve the same boundary. Session markup is injected by the host. The broker is bundled from the shared API schemas at build time, not compiled per request.

## Tier-scoped promise

Tier 0 keeps **the patch cannot watch you**. A public shell runs only Patchy's own shell script, never analytics (tier 0 needs no script). At tier 1: **a patch acts as you, only through Patchy, and never holds your login. What you do inside it can be saved in its own tables, which your colleagues can read, and every write is logged for your company's admins. It reaches outside systems only through your company's integrations.** This scopes, rather than removes, ADR-0006's session and no-script guarantees.
