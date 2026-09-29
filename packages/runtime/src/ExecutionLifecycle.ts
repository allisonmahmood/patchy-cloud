import { limitRefusalFields } from "@patchy/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { ExecutionBinding } from "./Executor.js";

export class LifecycleError extends Schema.TaggedError<LifecycleError>()("LifecycleError", {
  code: Schema.Literals(["busy", "patch_paused", "source_unavailable"]),
  status: Schema.Number,
  retryAfterSeconds: Schema.Number,
  limitId: limitRefusalFields.limitId,
  scope: limitRefusalFields.scope,
  value: limitRefusalFields.value,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Execution admission refused: ${this.code}.`;
  }
}

export interface Admission {
  readonly binding: ExecutionBinding;
  readonly release: Effect.Effect<void>;
}

/** Absent in no-pool dev. Presence follows the stream scope; admission follows settlement. */
export class ExecutionLifecycle extends Context.Service<
  ExecutionLifecycle,
  {
    readonly connect: (companyId: string) => Effect.Effect<void, LifecycleError, Scope.Scope>;
    readonly acquire: (
      companyId: string,
      patchId: string
    ) => Effect.Effect<Admission, LifecycleError>;
  }
>()("@patchy/runtime/ExecutionLifecycle") {}
