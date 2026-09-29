# Analytics

The business moments and runtime work the instance reports about itself. [Patches](../patches/CONTEXT.md) and [Auth](../auth/CONTEXT.md) decide which business moments matter; Analytics owns their reporting vocabulary and wide events.

## Language

**Analytics event**:
A server-side business moment: a patch created, updated, deleted or purged, or a machine token minted. It carries ids, sizes, counts and states, never page content, a filename, source address or URL; reporting is optional and its failure never fails the caller's request.
_Avoid_: telemetry, tracking, pageview, metric (an analytics event names what happened in the domain, not what the process measured)

**Principal of an event**:
Who an event belongs to: the user who acted, or the instance itself when no user is attributable. A wide event's viewer is its principal when known; the company is attribution, not a principal, and reporting creates no person profile.
_Avoid_: machine (the credential is provenance, not the actor), distinct id (PostHog's word for the same slot)

**Wide event**:
One structured record of a single hop of work, emitted once at its end. It sits beside the analytics event, shares its reporting client, and carries attribution, outcome, timing and peak limit usage without sampling; it is not the billing record.
_Avoid_: log line, metric, trace (the linkage, not the record)

**Limit peak**:
The highest observed use of a registry limit under one effective configuration revision, paired with its bound. A request event's `closestLimitId` names the greatest peak-to-bound ratio; a refusal's `limitId` names the limit that refused it. Database time and other additive measurements accumulate across callbacks, including callbacks on the private listener.
_Avoid_: remaining capacity (a peak records use), deployment revision (the host build, not the limit configuration)

**Deployment revision**:
The host build or deployment that emitted a wide event. It is distinct from the [Limits](../limits/CONTEXT.md) deployment configuration revision, which fingerprints the effective operating-limit values rather than the running code.
_Avoid_: configuration revision (the limits setting, not the host build)

**Shutdown flush**:
The bounded final opportunity for queued analytics events to be sent when the instance stops. An unavailable analytics backend must not hold shutdown open.
_Avoid_: graceful drain
