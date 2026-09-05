# Limits

The shared attempt limits used by the hosting server, device login and publishing. Consumers choose what an attempt is counted against; [Patches](../patches/CONTEXT.md) owns the separate live-patch quota.

## Language

**Rate limit**:
A per-window ceiling on attempts attributed to an address, machine token, device code or user, according to the action. It is temporary admission control, not a lasting count of what someone owns.
_Avoid_: quota (a quota is a database count that survives a restart), throttle

**Window**:
The fixed span over which a key's attempts are counted, starting with its first attempt and resetting at its end. A retry time says when to try again, not a reservation of capacity.
_Avoid_: bucket (the token-bucket algorithm, which this is not)

**Fails closed**:
The limiter's refusal of previously unseen keys when its capacity is full. Existing keys retain their windows; new callers retry until capacity becomes available, keeping memory bounded during a flood.
_Avoid_: fails open, sheds load
