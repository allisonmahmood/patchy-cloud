// @effect-diagnostics globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- wall-clock abort bounds inspection under TestClock; JSON encodes a typed request and the unknown reply is Schema-decoded.
import * as GuestProtocol from "@patchy/api/guest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { startWorkerd, type WorkerdProcess } from "./process.js";

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

/** Reuses a credential-free process; each uncached Worker dies with its inspection request. */
export const make = Effect.fn("Execution.Inspection.make")(function* (
  options: { readonly loadTimeoutMs?: number } = {}
) {
  const timeout = options.loadTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    return yield* new InspectionError({ reason: "protocol" });
  const admission = yield* Semaphore.make(1);
  let process: WorkerdProcess | undefined;
  let scope: Scope.Closeable | undefined;
  const discard = Effect.gen(function* () {
    const previous = scope;
    process = undefined;
    scope = undefined;
    if (previous !== undefined) yield* Scope.close(previous, Exit.void);
  });
  yield* Effect.addFinalizer(() => discard);
  const inspect = Effect.fn("Execution.Inspection.inspect")(
    function* (bundle: string) {
      if (process === undefined) {
        scope = yield* Scope.make();
        process = yield* startWorkerd().pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => new InspectionError({ reason: "process", cause }))
        );
      }
      return yield* describe(process.url, bundle, timeout);
    },
    Effect.onError(() => discard),
    admission.withPermits(1)
  );
  return { inspect };
});

/** Describes untrusted code in a throwaway process with no callback authority. */
export const inspect = Effect.fn("Execution.inspect")(function* (
  bundle: string,
  options: { readonly loadTimeoutMs?: number } = {}
) {
  const inspection = yield* make(options);
  return yield* inspection.inspect(bundle);
}, Effect.scoped);

const describe = Effect.fn("Execution.Inspection.describe")(function* (
  url: string,
  bundle: string,
  timeout: number
) {
  const body = yield* Effect.tryPromise({
    try: async (signal) => {
      const deadline = AbortSignal.timeout(timeout);
      const response = await fetch(`${url}/inspect`, {
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
});
