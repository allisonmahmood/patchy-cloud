import type { GuestProtocol } from "@patchy/api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ExecutionError extends Schema.TaggedError<ExecutionError>()("ExecutionError", {
  operation: Schema.Literals(["bind", "invoke"]),
  reason: Schema.Literals([
    "transport",
    "protocol",
    "bundle_required",
    "invalid_bundle",
    "binding_conflict",
    "load_failed"
  ]),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Execution ${this.operation} failed: ${this.reason}.`;
  }
}

/** Executes already-admitted work. Residency, admission and settlement belong to its callers. */
export class Executor extends Context.Service<
  Executor,
  {
    readonly bind: (
      bundle: GuestProtocol.Bundle
    ) => Effect.Effect<GuestProtocol.BundleBinding, ExecutionError>;
    readonly invoke: (
      request: GuestProtocol.Invoke
    ) => Effect.Effect<GuestProtocol.InvokeReply, ExecutionError>;
  }
>()("@patchy/runtime/Executor") {}
