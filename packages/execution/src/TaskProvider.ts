import type { GuestProtocol } from "@patchy/api";
import * as Management from "@patchy/api/management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface Task {
  readonly taskId: string;
  readonly deploymentRevision: string;
  readonly state: "running" | "stopped";
  readonly startedAt: number;
  readonly readyAt: number;
  readonly stoppedAt: number | null;
}

export class TaskProviderError extends Schema.TaggedError<TaskProviderError>()(
  "TaskProviderError",
  {
    operation: Schema.Literals(["start", "list", "quiesce", "stop", "bind", "invoke", "stats"]),
    taskId: Schema.optionalKey(Schema.String),
    reason: Schema.Union([Management.Refusal.fields.code, Schema.Literal("provider")]),
    limit: Schema.optionalKey(
      Schema.Struct({
        scope: Management.Refusal.fields.scope,
        limitId: Management.Refusal.fields.limitId,
        value: Management.Refusal.fields.value,
        retryAfter: Management.Refusal.fields.retryAfter
      })
    ),
    limits: Management.Refusal.fields.limits,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {
  override get message() {
    return `Execution task ${this.operation} failed: ${this.reason}.`;
  }
}

/**
 * All host clients address the same authoritative inventory. Identity survives ambiguous starts
 * and stops; closing a host does not stop its tasks. A stopped observation certifies actual exit.
 * Management calls are bounded; timeout is not evidence that a task stopped.
 */
export class TaskProvider extends Context.Service<
  TaskProvider,
  {
    readonly start: (input: {
      readonly taskId: string;
      readonly deploymentRevision: string;
    }) => Effect.Effect<Task, TaskProviderError>;
    readonly list: Effect.Effect<readonly Task[], TaskProviderError>;
    /** Stop guest processes but retain the supervisor until reports are persisted and acknowledged. */
    readonly quiesce: (
      taskId: string,
      bindingEpoch: number
    ) => Effect.Effect<void, TaskProviderError>;
    readonly stop: (taskId: string) => Effect.Effect<Task, TaskProviderError>;
    readonly bind: (
      taskId: string,
      request: Management.BindRequest
    ) => Effect.Effect<Management.BindReply, TaskProviderError>;
    readonly invoke: (
      taskId: string,
      request: Management.InvokeRequest
    ) => Effect.Effect<GuestProtocol.InvokeReply, TaskProviderError>;
    readonly stats: (
      taskId: string,
      request: Management.StatsRequest
    ) => Effect.Effect<Management.StatsReply, TaskProviderError>;
  }
>()("@patchy/execution/TaskProvider") {}
