import { Runtime, SubscriptionReads } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ConnectionStore from "./ConnectionStore.js";

/** Hosting composes this adapter over its resource reader at the existing Runtime seam. */
export const make = Effect.gen(function* () {
  const reads = yield* SubscriptionReads.SubscriptionReads;
  const connections = yield* ConnectionStore.ConnectionStore;
  const revisions = Effect.fn("ConnectionRevisions.revisions")(function* (
    companyId: string,
    keys: readonly string[]
  ) {
    const connectionKeys = keys.filter((key) => key.startsWith("connection:"));
    const otherKeys = keys.filter((key) => !key.startsWith("connection:"));
    const vector = otherKeys.length ? { ...(yield* reads.revisions(companyId, otherKeys)) } : {};
    if (!connectionKeys.length) return vector;
    const ids = connectionKeys.map((key) => key.slice("connection:".length));
    const facts = yield* connections
      .authorityRevisions(companyId, ids)
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    for (const [index, id] of ids.entries()) {
      const revision = facts.get(id);
      if (revision === undefined)
        return yield* new Runtime.SourceUnavailable({
          cause: new ConnectionStore.ConnectionNotFound({ companyId, lookup: { id } })
        });
      vector[connectionKeys[index]!] = revision;
    }
    return vector;
  });
  return SubscriptionReads.SubscriptionReads.of({ ...reads, revisions });
});

export const layer = Layer.effect(SubscriptionReads.SubscriptionReads, make);
