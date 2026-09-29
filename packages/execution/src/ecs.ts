import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type DescribeTaskDefinitionCommandInput,
  type DescribeTaskDefinitionCommandOutput,
  type DescribeTasksCommandInput,
  type DescribeTasksCommandOutput,
  type ListTasksCommandInput,
  type ListTasksCommandOutput,
  type RunTaskCommandInput,
  type RunTaskCommandOutput,
  type StopTaskCommandInput,
  type StopTaskCommandOutput
} from "@aws-sdk/client-ecs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class EcsError extends Schema.TaggedError<EcsError>()("EcsError", {
  operation: Schema.Literals([
    "describeTaskDefinition",
    "describeTasks",
    "listTasks",
    "runTask",
    "stopTask"
  ]),
  cause: Schema.Defect()
}) {
  override get message() {
    return `ECS ${this.operation} failed.`;
  }
}

/** SDK transport only. Ownership, readiness and reconciliation belong to the task provider. */
export class Ecs extends Context.Service<
  Ecs,
  {
    readonly describeTaskDefinition: (
      input: DescribeTaskDefinitionCommandInput
    ) => Effect.Effect<DescribeTaskDefinitionCommandOutput, EcsError>;
    readonly describeTasks: (
      input: DescribeTasksCommandInput
    ) => Effect.Effect<DescribeTasksCommandOutput, EcsError>;
    readonly listTasks: (
      input: ListTasksCommandInput
    ) => Effect.Effect<ListTasksCommandOutput, EcsError>;
    readonly runTask: (input: RunTaskCommandInput) => Effect.Effect<RunTaskCommandOutput, EcsError>;
    readonly stopTask: (
      input: StopTaskCommandInput
    ) => Effect.Effect<StopTaskCommandOutput, EcsError>;
  }
>()("@patchy/execution/ecs") {}

export const make = Effect.fn("Ecs.make")(function* (region: string) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new ECSClient({ region })),
    (value) => Effect.sync(() => value.destroy())
  );
  const request = <A>(operation: EcsError["operation"], run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new EcsError({ operation, cause })
    });
  return Ecs.of({
    describeTaskDefinition: (input) =>
      request("describeTaskDefinition", (abortSignal) =>
        client.send(new DescribeTaskDefinitionCommand(input), { abortSignal })
      ),
    describeTasks: (input) =>
      request("describeTasks", (abortSignal) =>
        client.send(new DescribeTasksCommand(input), { abortSignal })
      ),
    listTasks: (input) =>
      request("listTasks", (abortSignal) =>
        client.send(new ListTasksCommand(input), { abortSignal })
      ),
    runTask: (input) =>
      request("runTask", (abortSignal) => client.send(new RunTaskCommand(input), { abortSignal })),
    stopTask: (input) =>
      request("stopTask", (abortSignal) => client.send(new StopTaskCommand(input), { abortSignal }))
  });
});

export const layer = (region: string) => Layer.effect(Ecs, make(region));
