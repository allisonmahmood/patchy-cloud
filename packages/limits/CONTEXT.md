# Limits

The release's contract limits, operating defaults and company overrides, alongside the shared attempt limits used by the hosting server, device login and publishing. [Patches](../patches/CONTEXT.md) owns the separate live-patch quota.

## Language

**Contract limit**:
A bound patch code is written against, fixed per release and enforced identically in dev.
_Avoid_: quota, setting

**Operating limit**:
A bound on how Patchy runs its services and execution fleet, supplied by deployment configuration with company overrides where applicable.
_Avoid_: quota (a lasting count), tuning

**Limit override**:
A company's own value for an operating limit, set by a controller operation and kept with its history.
_Avoid_: exception, plan

**Rate limit**:
A ceiling on attempts attributed to an address, machine token, device code, user or company, according to the action. It is temporary admission control, not a lasting count of what someone owns.
_Avoid_: quota (a quota is a database count that survives a restart), throttle

**Window**:
The fixed span over which a key's attempts are counted, starting with its first attempt and resetting at its end. A retry time says when to try again, not a reservation of capacity.
_Avoid_: bucket (the token-bucket algorithm, which this is not)

**Token bucket**:
A call allowance that refills continuously at a rate and holds at most one burst's capacity. Company admission spends one token per top-level call, including calls that do not use a database connection.
_Avoid_: fixed window

**Fails closed**:
The limiter's refusal of previously unseen keys when its capacity is full. Existing keys retain their windows or buckets; new callers retry until capacity becomes available, keeping memory bounded during a flood.
_Avoid_: fails open, sheds load
