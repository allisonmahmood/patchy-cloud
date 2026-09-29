import * as WideEvents from "@patchy/analytics/wide-events";
import type { Invocation } from "@patchy/runtime/dev";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const settlement = Context.Reference<{ logged: boolean } | undefined>("patchy/devLog/settlement", {
  defaultValue: () => undefined
});

/** Settlement, rather than the HTTP reply, attributes calls that outlive their document. */
export const invocation = Effect.fn("DevLog.invocation")(function* (
  event: Invocation.DevSettlement,
  json: boolean
) {
  const current = yield* settlement;
  if (current !== undefined && event.parentId === null) current.logged = true;
  if (json) return yield* Console.log(encodeJson({ type: "invocation", ...event }));
  const lines = [
    `${event.initiatingViewerId} ${event.handler} ${event.outcomeCode ?? event.outcome} ${event.durationMs}ms`
  ];
  for (const entry of event.logLines) {
    if (entry !== null && typeof entry === "object" && "message" in entry) {
      lines.push(`  ${typeof entry.message === "string" ? entry.message : encodeJson(entry)}`);
      if ("details" in entry && entry.details !== undefined)
        lines.push(`  ${encodeJson(entry.details)}`);
    } else {
      lines.push(`  ${encodeJson(entry)}`);
    }
  }
  if (event.outcomeCode === "handler_failed" && event.diagnostic !== undefined) {
    lines.push(`  ${event.diagnostic.message}`);
    if (event.diagnostic.stack !== undefined) lines.push(event.diagnostic.stack);
  }
  yield* Console.log(lines.join("\n"));
});

/** Handler calls have a settlement line; JSON retains the complete request and re-run events. */
export const layer = (json: boolean) =>
  Layer.effect(
    WideEvents.WideEvents,
    Effect.map(WideEvents.make, (events) =>
      WideEvents.WideEvents.of({
        withEvent: (seed, work) =>
          Effect.suspend(() =>
            events.withEvent(seed, work).pipe(Effect.provideService(settlement, { logged: false }))
          )
      })
    )
  ).pipe(
    Layer.provide(
      Layer.succeed(WideEvents.Sink, {
        write: (event) =>
          Effect.gen(function* () {
            const current = yield* settlement;
            if (!json && "handler" in event && current?.logged) return;
            yield* Console.log(WideEvents.formatDev(event, { json }));
          })
      })
    )
  );
