# Analytics

The business moments the instance reports about itself. [Patches](../patches/CONTEXT.md) and [Auth](../auth/CONTEXT.md) decide which moments matter; Analytics owns their reporting vocabulary.

## Language

**Analytics event**:
A server-side business moment: a patch created, updated, deleted or expired, or a machine token minted. It carries ids, sizes, counts and states, never a visit, reader address, page content, filename or URL; reporting is optional and its failure never fails the caller's request.
_Avoid_: telemetry, tracking, pageview, metric (an analytics event names what happened in the domain, not what the process measured)

**Principal of an event**:
Who an event belongs to: the user who acted, or the instance itself for an expiry sweep. The reporting layer creates no person profile and reports no reader identity.
_Avoid_: machine (the credential is provenance, not the actor), distinct id (PostHog's word for the same slot)

**Shutdown flush**:
The bounded final opportunity for queued analytics events to be sent when the instance stops. An unavailable analytics backend must not hold shutdown open.
_Avoid_: graceful drain
