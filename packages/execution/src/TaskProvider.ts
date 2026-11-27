import type { GuestProtocol } from "@patchy/api";
import * as Management from "@patchy/api/management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A company box's size as Fargate counts it: CPU units (1024 is one vCPU) and MiB of memory. */
export interface Size {
  readonly cpu: number;
  readonly memory: number;
}
/** Today's box, the exec task definition's own size; a full launch asks for nothing else. */
export const full: Size = { cpu: 1024, memory: 2048 };
/**
 * A one-member company's box: half a vCPU with the same memory, so the supervisor's memory lines
 * and process cap hold unchanged.
 */
export const small: Size = { cpu: 512, memory: 2048 };
/** Whether a box of this size serves only a one-member company: anything less than full. */
export const isSmall = (size: Pick<Size, "cpu">) => size.cpu < full.cpu;

export interface Task {
  readonly taskId: string;
  readonly deploymentRevision: string;
  readonly state: "running" | "stopped";
  readonly startedAt: number;
  readonly readyAt: number;
  readonly stoppedAt: number | null;
  /** The size the provider observed the task running at; absent when it reported none valid. */
  readonly size?: Size;
}

export class TaskProviderError extends Schema.TaggedError<TaskProviderError>()(
  "TaskProviderError",
  {
    operation: Schema.Literals([
      "start",
      "list",
      "quiesce",
      "stop",
      "bind",
      "invoke",
      "stats",
      "touch"
    ]),
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
 * A start the provider answered by certainly creating nothing: ECS refused it outright on the
 * SDK's only attempt. Any failure less certain than that is a `TaskProviderError`. The ECS error,
 * when ECS answered with one rather than with failures, is its cause.
 */
export class LaunchRefused extends Schema.TaggedError<LaunchRefused>()("TaskLaunchRefused", {
  taskId: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Execution task ${this.taskId} was refused at launch; nothing was created.`;
  }
}
export const isLaunchRefused = Schema.is(LaunchRefused);

/**
 * Refusals of a bind by hash that prove it had no effect: a supervisor without the version, and
 * the decoding refusal a supervisor from before binds by hash gives the unknown `binding` key.
 * A local task owner can outlive its host's checkout, so even a host's own tasks may give it.
 */
const withoutBundle: ReadonlySet<string> = new Set(["bundle_required", "invalid_request"]);

/**
 * Sends a version bind by hash first, so a supervisor already holding the version gets no bytes.
 * Only after a decoded refusal that proves the bind by hash had no effect does the same bind go
 * again with its bundle; a transport or protocol failure is never followed by a second bind.
 * Fleet hosts send it only to supervisors of their own release, so older ones never pay for it.
 */
export const bindByHash = <E extends { readonly reason: string }, R>(
  request: Management.BindRequest,
  send: (request: Management.BindRequest) => Effect.Effect<Management.BindReply, E, R>
): Effect.Effect<Management.BindReply, E, R> => {
  const { bundle, ...rest } = request;
  if (bundle === undefined) return send(request);
  return send({
    ...rest,
    binding: {
      companyId: bundle.companyId,
      patchId: bundle.patchId,
      versionId: bundle.versionId,
      sha256: bundle.sha256
    }
  }).pipe(
    Effect.catchIf(
      (error) => withoutBundle.has(error.reason),
      () => send(request)
    )
  );
};

/**
 * The supervisor's answer to a touch, or `unsupported` when the task runs a release without
 * touches and none was sent.
 */
export type TouchResult = Management.TouchReply | { readonly outcome: "unsupported" };

/**
 * All host clients address the same shared inventory. Identity survives ambiguous starts
 * and stops; closing a host does not stop its tasks. A stopped observation certifies actual exit.
 * Omitted tasks and management timeouts are uncertainty, never evidence that a task stopped.
 * A start asks for a size and a retry asks for the same one; the task it answers reports the
 * size it really runs at. A start fails `LaunchRefused` only when it certainly created nothing.
 */
export class TaskProvider extends Context.Service<
  TaskProvider,
  {
    readonly start: (input: {
      readonly taskId: string;
      readonly deploymentRevision: string;
      readonly size: Size;
    }) => Effect.Effect<Task, TaskProviderError | LaunchRefused>;
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
    /** Never loads a version; a task whose supervisor predates touches is never sent one. */
    readonly touch: (
      taskId: string,
      request: Management.TouchRequest
    ) => Effect.Effect<TouchResult, TaskProviderError>;
  }
>()("@patchy/execution/TaskProvider") {}
