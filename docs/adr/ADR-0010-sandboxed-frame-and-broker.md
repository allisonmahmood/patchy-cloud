# ADR-0010: A sandboxed frame and a document-bound broker

Tier 1 patches run untrusted browser code on the same host as their human-readable addresses. They run in an opaque-origin frame, not in Patchy's authenticated document. A trusted shell binds one patch and version and brokers named operations as the reader; patch code never receives a session or integration credential. This keeps one address and one login door without granting uploaded script the host's authority.

Running uploaded script directly in the shell would grant same-origin session and
platform access. A separate subdomain would add host routing and login coordination
without removing the need for a trusted broker. The opaque-origin sandbox supplies
the isolation while keeping one host and the existing address/login model.

The decision implements [SDK spec §10](https://github.com/allisonmahmood/patchy-cloud/issues/193) and [issue #205](https://github.com/allisonmahmood/patchy-cloud/issues/205), following the [frame prototype](https://github.com/allisonmahmood/patchy-cloud/pull/185). Tier 0 retains its escaped `srcdoc` and empty sandbox. Tier 1 uses `/~content/<patchId>/<versionId>?n=<nonce>` and `sandbox="allow-scripts allow-modals"`. Historical pages use their selected version's tier. Content has the same door and sharing-based cache policy as its address.

## Containment and authority

The content response's CSP is `sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-ancestors 'self'`. Permissions-Policy denies camera, microphone and geolocation. The shell's `frame-src 'self'` contains script-initiated navigation and redirect egress; the iframe and HTTP sandbox must both grant a capability. Runtime file retrieval remains an attachment with a script-free sandbox CSP, never an executable uploaded document on the host.

Both static and scripted `/~content` responses allow only same-origin ancestors so the shell can frame them. Shells and first-party pages use `frame-ancestors 'none'`: they cannot themselves be embedded, even by a same-origin page.

The shell installs its load handler before navigating the frame. It transfers one MessageChannel to that document, with the URL nonce echoed in `ready { wire, nonce }`. A second load closes the port. Replies use the port, never the frame's WindowProxy, so a replacement document inherits neither pending replies nor authority. Bootstrap is bounded. There is no retry of an operation whose result was lost.

The envelope is `{ v, id, op, args, bytes? }`; replies are `{ v, id, kind: "result" | "error", value | error, bytes? }`. The bundle declares the wire, not a separate transport version. Own-property dispatch and the API operation schemas validate requests before forwarding; the server independently admits them. The broker binds ids and principal, sends the two `X-Patchy-*` headers and same-origin credentials, and carries files over bytes routes with ArrayBuffer transfers. Per-operation limits, 32 outstanding requests and 64 MiB held bytes bound a frame's work.
Owned upload buffers transfer through the shipped `patchy/client` transport and
detach; subviews copy only their selected bytes. Request byte defaults and
operation classification are shared API definitions, also used by Runtime.

Company shells pin the admitted viewer when rendered; the local shell obtains its principal through `me`. Public `me` is null and public company-data operations fail even for signed-in readers. A changed or expired session stops the patch and asks for sign-in followed by a whole-page reload. Access loss is a first-party notice without a reload offer; validation errors belong to patch code. Already-admitted work retains its original attribution; a missing reply remains an unknown outcome. Leaving the page closes the broker; a page restored from the back/forward cache reloads whole rather than reopening it.
`access_denied`, `session_expired`, `principal_changed` and `revoked` stop the
document. `not_available_on_public` remains a patch-visible refusal, and public
patches retain their browser-owned route bridge.

## Browser-owned behavior and compatibility

The route bridge keeps history in the shell, refuses Patchy-reserved segments, and notifies the document on back/forward. The shipped client exposes route get/set/subscribe and file download. File images use frame-local blob URLs with their stored media types; shell-owned downloads always use `application/octet-stream` so uploaded active content never becomes a same-origin document. Popups, external links, direct fetches, client storage, workers and device access are not patch capabilities. Printing remains available through `allow-modals`.

The scripted frame delegates `clipboard-write *` because its origin is opaque,
without delegating clipboard read. Copying is user-triggered and has a visible
failure path. Chromium can still deny the async clipboard API for that origin;
a user-triggered copy event is the compatibility path. Both engines are checked
by copying and pasting the actual text, not just observing a resolved promise.

An old shell with a supported bundle gets one cache-bypassing refresh. A repeated mismatch stops visibly rather than looping. A stored version whose wire has retired gets the first-party needs-rebuild door; a tooling release change alone never retires a deployed bundle.

`@patchy/serving/shell` exports rendering, the prebuilt broker script and CSP constants without Auth or platform infrastructure, so the local runtime can serve the same boundary. Session markup is injected by the host. The broker is bundled from the shared API schemas at build time, not compiled per request.

## Company document streams

Each company shell on tiers 1 and 2 opens one fetch-streamed SSE connection at
bootstrap, independently of patch code. Public shells and tier 0 do not open one.
The shell pins its admitted viewer, patch, loaded version and document nonce.
`GET /api/runtime/stream` rechecks the cookie session and version eligibility on
every open. `hello` supplies a new generation and the server clock; replacement
requires the previous generation while its stream is still connected. A lost
`hello`, including on a replacement connection, leaves conflicts retriable until
the abandoned connection closes; the generation fence is never bypassed. Frames
cross the existing bound port as `{ v, kind: "event", event: "stream", data }`.
The core transport maintains the clock estimate without handing patch code a credential.

The stream and its subscription POSTs must reach the same replica. A successful
stream sets the opaque, HTTP-only `patchy_stream_affinity` application cookie
under `/api/runtime`; it is routing state, never authority. Multi-replica ingress
must use application-cookie affinity, not independent round-robin requests.
For ALB the target group attributes are `stickiness.enabled=true`,
`stickiness.type=app_cookie`,
`stickiness.app_cookie.cookie_name=patchy_stream_affinity` and
`stickiness.app_cookie.duration_seconds=604800`, with cross-zone balancing enabled.
The browser sends both the application and ALB-generated cookies. On target loss,
a stale-generation refusal forces reconnect and re-admission on the replacement;
no subscription state or presence row is replicated. See
[ALB application-based stickiness](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html#application-based-stickiness).

A document is connected only while its stream is open. The host derives company,
patch and viewer counts in memory, without a presence row or heartbeat.
The registry limits a viewer to eight connected documents per patch. A further
document stops with a first-party notice rather than running without its stream;
the viewer can reopen it after closing another copy. The stream buffer defaults
to 16 MiB. Overflow discards pending frames and closes with
`closed { reason: "slow_consumer" }`; the shell reconnects. Each close emits one
stream wide event with delivered bytes, peak subscriptions and its close reason.

Every resource write and publish, rollback, sharing or lifecycle change commits
a revision in the same transaction. After commit, deduplicated resource keys wake
local subscribers and travel through Postgres NOTIFY to one listener per host.
Hints contain no rows or bytes and are not durable. Scoped workers coalesce wakes,
reread durable revisions and authority, and reconcile every 30 seconds by default.
They also reconcile after a listener reconnect or a document reconnect.
Publishing does not wait for subscriber reads. Initial snapshots and lifecycle dispatch
share a gate per patch, not per host: a delayed callback cannot overwrite a newer
version or stop a restored document, and unrelated patches proceed independently.
Retire and delete stop affected documents. Re-admission checks the existing patch
states and retained versions. No elapsed time discards a loaded version.

The `revoked` frame remains reserved. Who can revoke a version, where it is seen
and how it is undone are undecided in [#425](https://github.com/allisonmahmood/patchy-cloud/issues/425).
There is no revocation column or operation in this implementation.

The stream captures the verified token's expiry and closes for re-admission when
that deadline arrives. The expiry timer does no database or authentication I/O.
Re-admission checks the cookie and current company membership. At stream open,
a refreshable stale token asks the browser's existing session script to refresh;
only definitive session loss returns `session_expired`. Account changes and lost
company access remain stopping conditions. A company document keeps its stream
if its patch becomes public; public data-operation refusals remain errors for
patch code, not access-loss notices.
The shell forces at most three token refreshes per reconnect streak. A new
`hello`, returning from suspension or coming online resets that budget.
Refresh/network failures keep the document and its backoff; no operation is replayed.

EOF, a network cut and deployment drain use the same capped, jittered-backoff reconnect.
`pagehide` closes early; a hidden document suspends after 30 seconds and reopens
on return. Shutdown signals fence new runtime operations and streams before the
HTTP listener closes. Already-admitted work is not replayed.

The selected [S-C treatment](https://github.com/allisonmahmood/patchy-cloud/issues/385#issuecomment-5862481797)
is the served frame's named visual exception: a bottom-centre page-state pill,
widening for actions, built from core's shell component subset. Reconnecting
appears after two seconds and clears only when the current desired subscriptions
have reached their reconciliation fences, not on `hello`. A new-version
offer has **Not now**, retained across reconnect until the next publish, and
**Hide**, which collapses without dismissing. A tier 2 served version over a
lower-tier document shows **Reload to keep saving**, without dismissal. A rollback
to the loaded version clears the offer. Notices do not steal focus; Hide and
dismissal return focus to the frame. Reload warns that unsaved edits may be lost
and opens the currently served address, even from a numbered-version document,
preserving the client route, query and fragment.

The runtime loads the patch tier beside the document's eligible version at
admission. While the served tier is 2, lower-tier documents get `me` only;
every other direct operation is `server_required`. Rolling back to tier 1
reopens those documents' direct operations. A tier 2 document never gains
name-based tables, files, shared resources, connections or members, even after
rollback. Its generated client is server-only, with `me` and the route bridge;
authorised handles, staged uploads and generated downloads remain separate
shell capabilities as their implementation tickets land.

Tier 2 is company-only. Publish to a public patch requires explicit
`--share company`; public scope changes through the CLI or portal inspect the
served version and refuse `tier2_not_public`. Rolling a public patch back to a
tier 2 version is refused too; change its scope to company first.

Tier 1 owned and shared-table `list` and `get` subscriptions return whole snapshots
with decimal-string revision vectors. A missing `get` still depends on its table.
The shell sends ordered subscribe/unsubscribe changes or replaces the complete
desired set on reconnect. Generation and sequence fences discard obsolete work;
a persistent sequence gap requests a resync. Equal vectors receive up-to-date
without a read, and unchanged results advance their vectors without sending data.
Refused reads retain observed source dependencies so restore and reshare can recover.

Each document allows 64 subscriptions, each patch 256 and each company 1024;
each snapshot is bounded to 8 MiB. Reruns are limited to two
per company and one per patch. Overflow and stale-generation work never leave
unbounded listeners or queues.

Tier 2 streams now emit `starting` while the fleet binds the company, `ready` on
success and `start_failed` with busy and retryAfter after the bounded wait.
The broker holds calls within its normal bounds, including across stream loss,
and refuses held calls on failure without replay. The selected T-1 cover appears
after two seconds on first open and resume, holds focus with an accessible name,
and replaces the reconnecting pill while starting. It offers Try again after failure
and backs off automatic binding retries while open. Core owns its shared styles.

## Tier-scoped promise

Tier 0 keeps **the patch cannot watch you**. A public shell runs only Patchy's own shell script, never analytics (tier 0 needs no script). At tier 1: **a patch acts as you, only through Patchy, and never holds your login. What you do inside it can be saved in its own tables, which your colleagues can read, and every write is logged for your company's admins. It reaches outside systems only through your company's integrations.** This scopes, rather than removes, ADR-0006's session and no-script guarantees.

The tier 2 promise: **A tier 2 patch's server code runs on Patchy's machines,
never on yours. It holds no login and no credential and has no path to the
internet: everything it does goes through Patchy, as you, while you have the
patch open. It reaches outside systems only through your company's integrations,
and every write is logged for your company's admins.** ADR-0012 defines the
credential-free execution boundary and its resource-principal rules. Dev and
test instances admit published tier 2 versions on the local executor.
Production admission stays closed until the ECS task provider is available.
