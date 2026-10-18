import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Wakes from "./Wakes.js";

const channel = "patchy_runtime_wakes";
const Wake = Schema.fromJsonString(
  Schema.Struct({
    keys: Schema.Array(Schema.String.check(Schema.isMaxLength(512))),
    causedByEventId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
    // The publishing host. Older hosts and the directory trigger send none.
    origin: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64)))
  })
);
const decodeWake = Schema.decodeUnknownEffect(Wake);
const encodeWake = Schema.encodeSync(Wake);
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encoder = new TextEncoder();

export class WakeDeliveryFailed extends Schema.TaggedError<WakeDeliveryFailed>()(
  "WakeDeliveryFailed",
  { operation: Schema.Literals(["listen", "notify", "decode"]), cause: Schema.Defect() }
) {
  override get message() {
    return `Runtime wake ${this.operation} failed; durable reconciliation remains authoritative.`;
  }
}

/**
 * One LISTEN connection per host. A lost connection always forces durable reconciliation.
 * Publish wakes this host in memory, so its listener skips the NOTIFYs it sent itself.
 */
export const make = Effect.gen(function* () {
  const pg = yield* PgClient.PgClient;
  const local = yield* Wakes.make;
  const origin = yield* Effect.sync(randomUUID);
  const listen = Effect.scoped(
    Effect.gen(function* () {
      const notifications = yield* pg.listen(channel);
      // LISTEN is acknowledged before this read request, closing the reconnect gap.
      yield* local.publish([]);
      return yield* Effect.forever(
        Effect.gen(function* () {
          const notification = yield* Queue.take(notifications);
          const wake = yield* decodeWake(notification.payload).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(new WakeDeliveryFailed({ operation: "decode", cause })).pipe(
                Effect.as<typeof Wake.Type>({ keys: [] })
              )
            )
          );
          if (wake.origin !== origin) yield* local.publish(wake.keys, wake.causedByEventId);
        })
      );
    })
  );
  yield* Effect.forever(
    listen.pipe(
      Effect.catch((cause) =>
        Effect.logWarning(new WakeDeliveryFailed({ operation: "listen", cause }))
      ),
      Effect.andThen(Effect.sleep("1 second"))
    )
  ).pipe(Effect.forkScoped);
  return Wakes.Wakes.of({
    subscribe: local.subscribe,
    publish: Effect.fn("Wakes.publish")(function* (keys: readonly string[], cause?: string) {
      const causedByEventId = cause ?? (yield* WideEvents.currentEventId);
      yield* local.publish(keys, causedByEventId);
      // PostgreSQL NOTIFY accepts fewer than 8,000 bytes. Split keys, never resource data.
      const envelope = causedByEventId === undefined ? { origin } : { origin, causedByEventId };
      const overhead = encoder.encode(encodeWake({ keys: [], ...envelope })).byteLength;
      let batch: string[] = [];
      let bytes = overhead;
      const send = (values: readonly string[]) =>
        pg
          .notify(channel, encodeWake({ keys: values, ...envelope }))
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(new WakeDeliveryFailed({ operation: "notify", cause }))
            )
          );
      for (const key of new Set(keys)) {
        const size = encoder.encode(encodeKey(key)).byteLength + 1;
        if (bytes + size >= 8000) {
          yield* send(batch);
          batch = [];
          bytes = overhead;
        }
        batch.push(key);
        bytes += size;
      }
      if (batch.length > 0 || keys.length === 0) yield* send(batch);
    })
  });
});

export const layer = Layer.effect(Wakes.Wakes, make);
