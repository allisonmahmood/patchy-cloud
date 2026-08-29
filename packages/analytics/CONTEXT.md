# Analytics

The service every business moment the instance reports goes through. `packages/analytics` owns the event vocabulary, the PostHog layer and the no-op layer; the emitters (`auth`, `patches`, and the hosting server until they exist) decide what is reported.

## Language

**Analytics event**:
One business moment the instance reports to itself: a token minted, a patch created, updated, disabled, deleted, or expired. Server-side and nothing else — a served patch carries no analytics JavaScript, so a **visit is never one**, and no event carries a reader's address, page content, a filename, or a URL; what ships is ids, sizes, counts and states. Reporting never fails a request: `track` swallows a backend failure into a log line. An instance with no key configured reports nothing, and that is the default: reporting is something an operator switches on, never something an instance starts doing on its own.
_Avoid_: telemetry, tracking, pageview, metric (an analytics event names what happened in the domain, not what the process measured)

**Principal of an event**:
Who an event belongs to: the principal that acted, or the instance itself for the events no principal performed (an expiry sweep). Never a person: the reporting layer files every event without a person profile, because a principal is an ownership row and a reader is nobody at all.
_Avoid_: user, distinct id (PostHog's word for the same slot)

**Shutdown flush**:
The one bounded chance queued events get on the way down. The PostHog layer's finalizer flushes and gives up after three seconds, so a slow analytics backend never holds a shutdown.
_Avoid_: graceful drain
