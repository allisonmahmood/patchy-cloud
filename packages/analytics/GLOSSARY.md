# Analytics

The business moments and runtime work the instance reports about itself. [Patches](../patches/GLOSSARY.md), [Auth](../auth/GLOSSARY.md), [Companies](../companies/GLOSSARY.md), [Portal](../portal/GLOSSARY.md) and [Integrations](../integrations/GLOSSARY.md) decide which business moments matter; Analytics owns their reporting vocabulary and wide events.

## Language

**Analytics event**:
A server-side business moment, such as a patch published or a machine token minted. The catalogue in `src/Analytics.ts` names each event and the properties it carries. Every event names the company it happened in, and a patch event names the patch's owner at that moment. It carries ids, sizes, counts and states, and the identifiers a patch's manifest declares, never a person's or company's name, an email address, page content, a filename, source address, URL or free text; reporting is optional and its failure never fails the caller's request.
_Avoid_: telemetry, tracking, pageview, metric (an analytics event names what happened in the domain, not what the process measured)

**Principal of an event**:
Who an event belongs to: the user who acted, or the instance itself when no user is attributable. A wide event's viewer is its principal when known; the company is attribution, not a principal, and reporting creates no person profile.
_Avoid_: machine (the credential is provenance, not the actor), distinct id (PostHog's word for the same slot)

**Wide event**:
One structured record of a single hop of work, emitted once at its end. It sits beside the analytics event, shares its reporting client, and carries attribution, outcome, timing and peak limit usage without sampling; it is not the billing record.
_Avoid_: log line, metric, trace (the linkage, not the record)

**Request event**:
The wide event for one server request. Runtime requests record their own, as [Runtime](../runtime/GLOSSARY.md) defines; every other request names its matched route template, never the URL, with the method and the status the client received. A `patchy` CLI request adds the CLI's release, command and coding agent from its `Patchy-Cli` header, each only when it parses. The outcome follows that status: a 4xx is refused with its body's code, a 5xx is a failure. Health probes emit none.
_Avoid_: access log (it records URLs), request log

**Subscription request event**:
The request event for one subscription POST. It names the desired-set change (`subscriptionRequest`) and its `sequence`, the `documentId` and the generation it named (`streamId`), whether this host holds that document (`documentConnected`) and, when it does, the document's generation and sequence here (`currentStreamId`, `currentSequence`). A 409 names its `refusal`: `stream_replaced` or `stale_sequence`. Three booleans say whether the request carried the stream affinity cookie (`affinityCookie`), whether that cookie names this host (`affinityMatched`) and whether a load balancer stickiness cookie came with it (`balancerCookie`); cookie values are never recorded. The `replica` every event carries names the receiving host.
_Avoid_: control log

**Re-run event**:
The wide event for one subscription run, from taking a re-run slot to releasing it, so its duration includes the admission and revision checks before the read. It names its `documentId`, its stream generation (`streamId`), the admitted `taskId` with the process generation, its trigger, its disposition and its waits. A slot that ends at the revision check without a read, almost always an up-to-date answer, emits none; the stream event counts those checks (`checks`) and the slot time they occupied (`checkMs`).
_Avoid_: query event, job

**Slot wait**:
`slotWaitMs`: how long a dirty subscription waited for a re-run slot, from its first dirty transition to taking the slot. Coalesced dirt keeps the oldest. It includes time behind capped runs and behind the subscription's own previous run. Its clock starts no earlier than the document's execution becoming ready or a retry's backoff ending; `readyWaitMs` records the wait for ready and `backoffMs` a retry's backoff. It is not `queueWaitMs`, the connection and callback waits inside a run.
_Avoid_: queue wait (the waits inside a run), latency

**Trigger**:
What first made a run's subscription dirty: `initial` (newly installed), `replace` (re-sent unchanged in a desired set), `invalidation` (a wake, including one received during its previous run), `retry` (a recoverable failure's backoff ended, or a read fell behind its fence), `periodic` (durable reconciliation), `rebind` (a development handler swap) or `ready` (execution became ready). `ready` is rare: subscriptions installed while execution starts are already dirty, so they keep `initial` and report `readyWaitMs`.
_Avoid_: cause (`causedByEventId` names the write behind a wake)

**Disposition**:
What became of a run's result: `delivered` as a snapshot, `unchanged` as up-to-date, or `discarded` because its epoch changed, its subscription or document went away, or its read fell behind its fence. A run that sent an error or a refusal has none; its outcome says so.
_Avoid_: outcome (whether the work succeeded)

**Limit peak**:
The highest observed use of a registry limit under one effective configuration revision, paired with its bound. A request event's `closestLimitId` names the greatest peak-to-bound ratio; a refusal's `limitId` names the limit that refused it. Database time and other additive measurements accumulate across callbacks, including callbacks on the private listener.
_Avoid_: remaining capacity (a peak records use), deployment revision (the host build, not the limit configuration)

**Deployment revision**:
The host build or deployment that emitted a wide event. It is distinct from the [Limits](../limits/GLOSSARY.md) deployment configuration revision, which fingerprints the effective operating-limit values rather than the running code.
_Avoid_: configuration revision (the limits setting, not the host build)

**Shutdown flush**:
The bounded final opportunity for queued analytics events to be sent when the instance stops. An unavailable analytics backend must not hold shutdown open.
_Avoid_: graceful drain
