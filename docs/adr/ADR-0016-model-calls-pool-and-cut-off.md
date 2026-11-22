# ADR-0016 — Model calls hold the model pool and stop at their action's deadline

A tier 2 action calls a company's model role through the host ([#1489](https://github.com/allisonmahmood/patchy-cloud/issues/1489)). A model can take most of an action's 60 seconds to answer, which no other integration call does, so two things are decided here that are hard to change once patches rely on them.

**An action that calls a model leaves its action slot for the model pool, once, and holds its place there until it ends.** It moves on its first model call that has passed its first check, before it takes any other capacity; the move frees its ordinary slot and never reverses, and a refused move keeps the ordinary slot and sends nothing (`busy`, naming `tier2.models.company`, `tier2.models.viewer` or `tier2.models.replica`). The move records those three limits with their peaks in the action's event. Under today's counting, eight people on 30-second model calls let none of 100 quick actions from five others run; under the pool all 100 ran (shown on #1482). Beside it, the host holds each action to four model calls running and 200 in all, and each server process has one admission queue granting a host permit and a provider record's permit together. A bound per execution process, taken before the callback's body is read, comes with the next slice.

**A model call's fence is its action's own deadline, not the 15-second integration deadline.** Once the request is prepared, the call's final check asks the viewer's door again, then reads the role, its provider, the patch owner's authority and the provider's key from one snapshot; that key is the one sent. After that check, immediately before the request reaches the transport, a call with less than two seconds left (`models.send.floor`) is not sent, and a call waiting for capacity gives up early enough to keep that floor. The whole call, its store reads and checks included, ends one second before the deadline (`models.cutoff`), closing a sent request's connection, a target for the handler to hear why, not a guarantee. One request per call, never retried and never following a redirect.

**Four outcomes are kept apart, in `details.sent`.** `busy` with the limit that refused, nothing sent; `timeout` with `sent: false`, too little time left, nothing sent; `timeout` with `sent: true`, cut off after the request reached the transport, which the provider may still charge; and a reply lost in transit, where `sent` is absent because dispatch is unknown. Every other refusal the host gives a model call says `sent` too, those before its handler runs included. The execution process's own refusal when a callback can't complete carries none, which reads as unknown; that is the next slice's to settle. Retrying a call that was sent, or whose dispatch is unknown, can charge again; Patchy never retries one.

## Considered options

- **Park the action while its call waits**, freeing its slot and taking one again after. Rejected: the action needs a slot back exactly when many calls finish together, and a full replica then refuses work that already spent money.
- **Keep `integration.deadline`.** Rejected: a 20-second answer, ordinary for a model, would always time out (shown on #1482).
- **Retry a refused or lost call on the host.** Rejected: a provider may have charged for it, and only the patch knows whether a second charge is worth it.

## Consequences

**Capacity is per replica.** Two replicas count separately, as actions do today. The pool's company and person limits are overridable per company; the replica's and the processes' settings are deployment configuration.

**A call past the final check may complete.** A pause, a remap, a replaced key or lost access that lands after the final check's read doesn't stop the request; one that lands before that read sends nothing.
