# Limits

The fixed-window rate limiter behind every per-minute limit the hosting server enforces. `packages/limits` owns the window, the store and its cap; which limits exist, what they key on and how many attempts they admit is the consumer's, and the long-window ceilings (mint quota, patch quota) are database counts owned elsewhere.

## Language

**Rate limit**:
A per-window ceiling on attempts for one key — a source address or a token id — spent one attempt at a time through `Limits.consume`, which answers with what is left and, on refusal, what `Retry-After` should say. In memory, so a restart empties every window. Every limit shares one store, so a consumer prefixes its keys with the limit's name.
_Avoid_: quota (a quota is a database count that survives a restart), throttle

**Window**:
The fixed span a key's attempts are counted over, opened by the first attempt and reset at its end; a refusal reports the whole seconds until then, never less than one. Fixed rather than sliding: the reset boundary is exact, and a caller told to retry after it will be admitted.
_Avoid_: bucket (the token-bucket algorithm, which this is not)

**Fails closed**:
The store's posture at its cap of 10,000 tracked keys: a key it has never seen is refused, with a `Retry-After` pointing at the earliest reset, until an expired window frees a slot. A flood of fresh addresses can exhaust memory no faster than it can wait out a window, at the cost of refusing a genuinely new caller during one.
_Avoid_: fails open, sheds load
