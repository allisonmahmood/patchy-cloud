import { limitRefusalFields, type GuestProtocol } from "@patchy/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ExecutionError extends Schema.TaggedError<ExecutionError>()("ExecutionError", {
  operation: Schema.Literals(["bind", "invoke"]),
  reason: Schema.Literals([
    "transport",
    "protocol",
    "bundle_required",
    "invalid_bundle",
    "binding_conflict",
    "load_failed",
    "busy",
    "stale_generation",
    "process_killed",
    "production_refused"
  ]),
  limit: Schema.optionalKey(Schema.Struct(limitRefusalFields)),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Execution ${this.operation} failed: ${this.reason}.`;
  }
}

export interface BoundVersion {
  readonly binding: GuestProtocol.BundleBinding;
  readonly processGeneration?: number;
}

/** Executes already-admitted work. Residency, admission and settlement belong to its callers. */
export class Executor extends Context.Service<
  Executor,
  {
    readonly bind: (bundle: GuestProtocol.Bundle) => Effect.Effect<BoundVersion, ExecutionError>;
    readonly invoke: (
      request: GuestProtocol.Invoke
    ) => Effect.Effect<GuestProtocol.InvokeReply, ExecutionError>;
  }
>()("@patchy/runtime/Executor") {}
