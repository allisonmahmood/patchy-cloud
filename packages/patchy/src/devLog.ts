import * as WideEvents from "@patchy/analytics/wide-events";
import type { PidgeonDev } from "@patchy/integrations/dev";
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
  // An agent's call reads as its person via the agent, as the platform log says it.
  const who =
    event.agent === null
      ? event.initiatingViewerId
      : `${event.initiatingViewerId} via ${event.agent.name}`;
  const lines = [
    `${who} ${event.handler} ${event.outcomeCode ?? event.outcome} ${event.durationMs}ms`
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
  yield* Console.log(lines.join("\n"));
});

/**
 * A write dev answered itself instead of sending, such as a Pidgeon send: who made it, on which
 * connection, and its recipients and subject as recent calls name them.
 */
export const simulated = Effect.fn("DevLog.simulated")(function* (
  write: PidgeonDev.Simulated,
  json: boolean
) {
  yield* Console.log(
    json
      ? encodeJson({ type: "simulated", ...write })
      : `${write.viewerId} ${write.connection} ${write.summary}: simulated in dev, nothing reached Pidgeon`
  );
});

/**
 * Handler calls have a settlement line; JSON retains the complete request, re-run and process
 * events. Compact lines stay about calls, so a process's start and lifetime are JSON only.
 */
export const layer = (json: boolean) =>
  Layer.effect(
    WideEvents.WideEvents,
    Effect.map(WideEvents.make, (events) =>
      WideEvents.WideEvents.of({
        emit: events.emit,
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
            if (!json && event.type === "process") return;
            yield* Console.log(WideEvents.formatDev(event, { json }));
          })
      })
    )
  );
