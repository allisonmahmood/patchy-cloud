// @effect-diagnostics globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- wall-clock abort bounds inspection under TestClock; JSON encodes a typed request and the unknown reply is Schema-decoded.
import * as GuestProtocol from "@patchy/api/guest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { startWorkerd } from "./process.js";

export class InspectionError extends Schema.TaggedError<InspectionError>()("InspectionError", {
  reason: Schema.Literals(["process", "load", "timeout", "protocol"]),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Server bundle inspection failed: ${this.reason}.`;
  }
}
const decodeReply = Schema.decodeUnknownEffect(GuestProtocol.InspectionReply, {
  onExcessProperty: "error"
});

/** Describes untrusted code without a company binding or any callback authority. */
export const inspect = Effect.fn("Execution.inspect")(function* (
  bundle: string,
  options: { readonly loadTimeoutMs?: number } = {}
) {
  const timeout = options.loadTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    return yield* new InspectionError({ reason: "protocol" });
  const process = yield* startWorkerd().pipe(
    Effect.mapError((cause) => new InspectionError({ reason: "process", cause }))
  );
  const body = yield* Effect.tryPromise({
    try: async (signal) => {
      const deadline = AbortSignal.timeout(timeout);
      const response = await fetch(`${process.url}/inspect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wire: GuestProtocol.wireVersion,
          bundle
        } satisfies GuestProtocol.InspectRequest),
        signal: AbortSignal.any([signal, deadline])
      });
      return (await response.json()) as unknown;
    },
    catch: (cause) =>
      new InspectionError({
        reason: cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "load",
        cause
      })
  });
  const reply = yield* decodeReply(body).pipe(
    Effect.mapError((cause) => new InspectionError({ reason: "protocol", cause }))
  );
  if (!reply.ok) return yield* new InspectionError({ reason: "load" });
  return reply.handlers;
}, Effect.scoped);
