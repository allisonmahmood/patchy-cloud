// @effect-diagnostics nodeBuiltinImport:off -- ECS idempotency tokens use Node's SHA-256 implementation.
import { createHash } from "node:crypto";
import type { Task } from "@aws-sdk/client-ecs";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import * as DeploymentConfig from "@patchy/limits/deployment-config";
import { registry } from "@patchy/limits/registry";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Ecs from "./ecs.js";
import * as TaskProvider from "./TaskProvider.js";

const decodeBind = Schema.decodeUnknownEffect(Management.BindReply);
const decodeInvoke = Schema.decodeUnknownEffect(GuestProtocol.InvokeReply);
const decodeStats = Schema.decodeUnknownEffect(Management.StatsReply);
const decodeRefusal = Schema.decodeUnknownEffect(Management.Refusal);
const isProviderError = Schema.is(TaskProvider.TaskProviderError);
const taskDefinition = Schema.NonEmptyString.check(
  Schema.isPattern(/^arn:[^:]+:ecs:[^:]+:\d+:task-definition\/[\w-]+:[1-9]\d*$/)
);
const validDefinition = Schema.is(taskDefinition);
const validIdentity = Schema.is(Schema.NonEmptyString.check(Schema.isMaxLength(256)));
const validPort = Schema.is(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })));
const validCallbackUrls = Schema.is(Management.CallbackUrls);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const familyOf = (definition: string) =>
  definition.slice(definition.indexOf("/") + 1, definition.lastIndexOf(":"));
const ownerTag = "patchy:execution-fleet";
const taskTag = "patchy:execution-task";
const revisionTag = "patchy:deployment-revision";
const roleTag = "patchy:role";
type Operation = TaskProvider.TaskProviderError["operation"];
type ManagedTask = {
  readonly value: Task;
  readonly taskId: string;
  readonly deploymentRevision: string;
};

export interface Revision {
  readonly deploymentRevision: string;
  /** Exact task-definition ARN, including its numeric revision. Never a mutable family name. */
  readonly taskDefinition: string;
  readonly secret: Redacted.Redacted<string>;
}

export interface Options {
  readonly region: string;
  readonly cluster: string;
  /** Stable across host replacements and deployment revisions; unique within the cluster. */
  readonly fleetId: string;
  /** Private subnets with endpoint routes only, never a default internet/NAT route. */
  readonly subnetIds: readonly string[];
  /** Retained for the task lifetime: endpoints plus the hosts' private callback port only. */
  readonly bootstrapSecurityGroupId: string;
  readonly current: Revision;
  readonly previous?: Revision;
  /** Trusted private listeners, including this replica and retained rollout hosts. */
  readonly callbackUrls: readonly string[];
  readonly managementPort?: number;
  readonly containerName?: string;
}

/** Host-only configuration. SDK credentials come from the host task role, never from this config. */
export const config = Config.all({
  region: Config.NonEmptyString("ECS_REGION").pipe(
    Config.orElse(() => Config.NonEmptyString("AWS_REGION")),
    Config.withDefault("us-east-1")
  ),
  cluster: Config.NonEmptyString("ECS_CLUSTER"),
  fleetId: Config.NonEmptyString("EXECUTION_FLEET_ID"),
  subnetIds: Config.schema(
    Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
    "ECS_EXEC_SUBNET_IDS"
  ),
  bootstrapSecurityGroupId: Config.NonEmptyString("ECS_EXEC_BOOTSTRAP_SECURITY_GROUP_ID"),
  current: Config.all({
    deploymentRevision: Config.NonEmptyString("EXECUTION_DEPLOYMENT_REVISION"),
    taskDefinition: Config.schema(taskDefinition, "ECS_EXEC_TASK_DEFINITION"),
    secret: Config.schema(Schema.Redacted(Schema.NonEmptyString), "EXECUTION_MANAGEMENT_SECRET")
  }),
  previousRevision: Config.option(Config.NonEmptyString("EXECUTION_PREVIOUS_DEPLOYMENT_REVISION")),
  previousDefinition: Config.option(
    Config.schema(taskDefinition, "ECS_EXEC_PREVIOUS_TASK_DEFINITION")
  ),
  previousSecret: Config.option(
    Config.schema(Schema.Redacted(Schema.NonEmptyString), "EXECUTION_MANAGEMENT_PREVIOUS_SECRET")
  ),
  callbackUrls: Config.schema(
    Schema.fromJsonString(Management.CallbackUrls),
    "EXECUTION_CALLBACK_URLS"
  ),
  managementPort: Config.Int("EXECUTION_MANAGEMENT_PORT").pipe(Config.withDefault(8788)),
  containerName: Config.NonEmptyString("ECS_EXEC_CONTAINER_NAME").pipe(Config.withDefault("exec"))
}).pipe(
  Config.map(({ previousRevision, previousDefinition, previousSecret, ...options }): Options => ({
    ...options,
    // A partial previous revision fails make's validation instead of silently losing rollout auth.
    ...(Option.isSome(previousRevision) ||
    Option.isSome(previousDefinition) ||
    Option.isSome(previousSecret)
      ? {
          previous: {
            deploymentRevision: Option.getOrElse(previousRevision, () => ""),
            taskDefinition: Option.getOrElse(previousDefinition, () => ""),
            secret: Option.getOrElse(previousSecret, () => Redacted.make(""))
          }
        }
      : {})
  }))
);

/** Closing a host destroys its SDK client, not its tasks. ECS remains the shared inventory. */
export const make = Effect.fn("EcsTaskProvider.make")(function* (options: Options) {
  const http = yield* HttpClient.HttpClient;
  const client = yield* Ecs.Ecs;
  const limits = yield* DeploymentConfig.load;
  const startupTimeout = limits.get("execution.pool.wait");
  const managementTimeout = registry["tier2.settlement.cleanup"].default + 5_000;
  const managementPort = options.managementPort ?? 8788;
  const containerName = options.containerName ?? "exec";
  const revisions = [
    options.current,
    ...(options.previous === undefined ? [] : [options.previous])
  ];
  if (
    !validIdentity(options.fleetId) ||
    !validPort(managementPort) ||
    options.subnetIds.length === 0 ||
    options.callbackUrls.length === 0 ||
    !validCallbackUrls(options.callbackUrls) ||
    !options.bootstrapSecurityGroupId ||
    revisions.some(
      (revision) =>
        !validIdentity(revision.deploymentRevision) ||
        !validDefinition(revision.taskDefinition) ||
        Redacted.value(revision.secret).length === 0
    ) ||
    (options.previous !== undefined &&
      options.previous.deploymentRevision === options.current.deploymentRevision) ||
    revisions.some(
      (revision) => familyOf(revision.taskDefinition) !== familyOf(options.current.taskDefinition)
    )
  )
    return yield* new TaskProvider.TaskProviderError({ operation: "start", reason: "provider" });

  const startedBy = digest(options.fleetId).slice(0, 36);
  const group = `patchy-exec:${startedBy}`;
  const family = familyOf(options.current.taskDefinition);
  const addresses = new Map<string, string>();
  const readiness = new Map<string, number>();
  const bounded = <A, E>(
    operation: Operation,
    taskId: string | undefined,
    effect: Effect.Effect<A, E>,
    timeout = managementTimeout
  ) =>
    effect.pipe(
      Effect.timeout(timeout),
      Effect.mapError((cause) =>
        isProviderError(cause)
          ? cause
          : new TaskProvider.TaskProviderError({
              operation,
              ...(taskId === undefined ? {} : { taskId }),
              reason: Cause.isTimeoutError(cause) ? "transport" : "protocol",
              cause
            })
      )
    );
  const aws = <A>(
    operation: Operation,
    taskId: string | undefined,
    effect: Effect.Effect<A, Ecs.EcsError>
  ) =>
    bounded(
      operation,
      taskId,
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new TaskProvider.TaskProviderError({
              operation,
              ...(taskId === undefined ? {} : { taskId }),
              reason: "provider",
              cause
            })
        )
      )
    );

  // Do not trust a mutable task family or a definition that supplies guest-accessible credentials.
  for (const revision of revisions) {
    const response = yield* aws(
      "start",
      undefined,
      client.describeTaskDefinition({ taskDefinition: revision.taskDefinition })
    );
    const definition = response.taskDefinition;
    const containers = definition?.containerDefinitions ?? [];
    if (
      definition?.taskDefinitionArn !== revision.taskDefinition ||
      definition.taskRoleArn ||
      definition.networkMode !== "awsvpc" ||
      !definition.requiresCompatibilities?.includes("FARGATE") ||
      containers.length !== 1 ||
      containers[0]?.name !== containerName ||
      !["0", "root", "0:0", "root:root"].includes(containers[0]?.user ?? "") ||
      containers.some(
        (container) =>
          (container.secrets?.length ?? 0) > 0 ||
          (container.environmentFiles?.length ?? 0) > 0 ||
          container.environment?.some((entry) =>
            /^(AWS_|ECS_CONTAINER_CREDENTIALS)/.test(entry.name ?? "")
          )
      )
    )
      return yield* new TaskProvider.TaskProviderError({ operation: "start", reason: "provider" });
  }

  const owned = (value: Task): ManagedTask | undefined => {
    const tags = new Map(value.tags?.map((tag) => [tag.key, tag.value]));
    const taskId = tags.get(taskTag);
    const deploymentRevision = tags.get(revisionTag);
    if (
      tags.get(ownerTag) !== options.fleetId ||
      tags.get(roleTag) !== "exec" ||
      !taskId ||
      !deploymentRevision ||
      !value.taskArn ||
      value.startedBy !== startedBy ||
      value.group !== group ||
      !value.taskDefinitionArn ||
      familyOf(value.taskDefinitionArn) !== family
    )
      return undefined;
    addresses.set(taskId, value.taskArn);
    return { value, taskId, deploymentRevision };
  };
  const describe = Effect.fn("EcsTaskProvider.describe")(function* (
    arns: readonly string[],
    operation: Operation,
    taskId?: string
  ) {
    const tasks: ManagedTask[] = [];
    for (let offset = 0; offset < arns.length; offset += 100) {
      const response = yield* aws(
        operation,
        taskId,
        client.describeTasks({
          cluster: options.cluster,
          tasks: arns.slice(offset, offset + 100),
          include: ["TAGS"]
        })
      );
      if (response.failures?.some((failure) => failure.reason !== "MISSING"))
        return yield* new TaskProvider.TaskProviderError({
          operation,
          ...(taskId === undefined ? {} : { taskId }),
          reason: "provider"
        });
      for (const task of response.tasks ?? []) {
        const managed = owned(task);
        if (managed !== undefined) tasks.push(managed);
      }
    }
    return tasks;
  });
  const inventory = Effect.fn("EcsTaskProvider.inventory")(function* (
    operation: Operation,
    taskId?: string
  ) {
    // ListTasks is eventually consistent. Never discard a known ARN merely because it is omitted.
    const arns = new Set(addresses.values());
    // PENDING tasks have desiredStatus RUNNING. ECS retains stopped tasks for at least one hour.
    for (const desiredStatus of ["RUNNING", "STOPPED"] as const) {
      let nextToken: string | undefined;
      do {
        const page = yield* aws(
          operation,
          taskId,
          client.listTasks({
            cluster: options.cluster,
            family,
            desiredStatus,
            maxResults: 100,
            ...(nextToken === undefined ? {} : { nextToken })
          })
        );
        for (const arn of page.taskArns ?? []) arns.add(arn);
        if (page.nextToken !== undefined && page.nextToken === nextToken)
          return yield* new TaskProvider.TaskProviderError({
            operation,
            ...(taskId === undefined ? {} : { taskId }),
            reason: "provider"
          });
        nextToken = page.nextToken;
      } while (nextToken !== undefined);
    }
    return yield* describe([...arns], operation, taskId);
  });
  const resolve = Effect.fn("EcsTaskProvider.resolve")(function* (
    taskId: string,
    operation: Operation
  ) {
    const arn = addresses.get(taskId);
    const tasks =
      arn === undefined
        ? yield* inventory(operation, taskId)
        : yield* describe([arn], operation, taskId);
    const matches = tasks.filter((task) => task.taskId === taskId);
    if (matches.length !== 1)
      return yield* new TaskProvider.TaskProviderError({
        operation,
        taskId,
        reason: matches.length === 0 ? "transport" : "provider"
      });
    return matches[0]!;
  });
  const observation = Effect.fn("EcsTaskProvider.observation")(function* (
    task: ManagedTask,
    operation: Operation
  ) {
    const stopped = task.value.lastStatus === "STOPPED";
    const startedAt = (task.value.startedAt ?? task.value.createdAt)?.getTime();
    const stoppedAt = task.value.stoppedAt?.getTime();
    if (startedAt === undefined || (stopped && stoppedAt === undefined))
      return yield* new TaskProvider.TaskProviderError({
        operation,
        taskId: task.taskId,
        reason: "provider"
      });
    const readyAt = readiness.get(task.taskId) ?? 0;
    if (stopped) {
      addresses.delete(task.taskId);
      readiness.delete(task.taskId);
    }
    return {
      taskId: task.taskId,
      deploymentRevision: task.deploymentRevision,
      state: stopped ? ("stopped" as const) : ("running" as const),
      startedAt,
      readyAt,
      stoppedAt: stopped ? stoppedAt! : null
    };
  });
  const post = Effect.fn("EcsTaskProvider.post")(function* (
    task: ManagedTask,
    operation: Operation,
    path: string,
    body: unknown
  ) {
    if (task.value.lastStatus === "STOPPED")
      return yield* new TaskProvider.TaskProviderError({
        operation,
        taskId: task.taskId,
        reason: "stopped"
      });
    const revision = revisions.find(
      (entry) => entry.deploymentRevision === task.deploymentRevision
    );
    // An older host authenticates a newly promoted revision with that supervisor's previous secret.
    const secret = revision?.secret ?? options.current.secret;
    const address = task.value.attachments?.flatMap((attachment) =>
      attachment.type === "ElasticNetworkInterface"
        ? (attachment.details
            ?.filter((detail) => detail.name === "privateIPv4Address")
            .map((detail) => detail.value) ?? [])
        : []
    )[0];
    if (!address || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(address))
      return yield* new TaskProvider.TaskProviderError({
        operation,
        taskId: task.taskId,
        reason: "provider"
      });
    const response = yield* http
      .execute(
        HttpClientRequest.post(`http://${address}:${managementPort}/${path}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(secret)}`),
          HttpClientRequest.bodyJsonUnsafe(body)
        )
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new TaskProvider.TaskProviderError({
              operation,
              taskId: task.taskId,
              reason: "transport",
              cause
            })
        )
      );
    if (path === "stop" && response.status === 204) return undefined;
    const value = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new TaskProvider.TaskProviderError({
            operation,
            taskId: task.taskId,
            reason: "protocol",
            cause
          })
      )
    );
    if (response.status !== 200) {
      const refusal = yield* decodeRefusal(value).pipe(
        Effect.mapError(
          (cause) =>
            new TaskProvider.TaskProviderError({
              operation,
              taskId: task.taskId,
              reason: "protocol",
              cause
            })
        )
      );
      return yield* new TaskProvider.TaskProviderError({
        operation,
        taskId: task.taskId,
        reason: refusal.code,
        limit: {
          ...(refusal.scope === undefined ? {} : { scope: refusal.scope }),
          ...(refusal.limitId === undefined ? {} : { limitId: refusal.limitId }),
          ...(refusal.value === undefined ? {} : { value: refusal.value }),
          ...(refusal.retryAfter === undefined ? {} : { retryAfter: refusal.retryAfter })
        },
        ...(refusal.limits === undefined ? {} : { limits: refusal.limits })
      });
    }
    if (path === "stop")
      return yield* new TaskProvider.TaskProviderError({
        operation,
        taskId: task.taskId,
        reason: "protocol"
      });
    return value;
  });
  const ready = Effect.fn("EcsTaskProvider.ready")(function* (task: ManagedTask) {
    if (task.value.lastStatus !== "RUNNING") return false;
    return yield* bounded(
      "start",
      task.taskId,
      post(task, "start", "stats", { bindingEpoch: 0 }).pipe(
        Effect.flatMap(decodeStats),
        Effect.map((stats) => !stats.stopped),
        Effect.catchTags({
          TaskProviderError: (cause) =>
            cause.reason === "stale_epoch" ? Effect.succeed(true) : Effect.fail(cause)
        })
      ),
      2_000
    ).pipe(Effect.catch(() => Effect.succeed(false)));
  });
  const waitReady = Effect.fn("EcsTaskProvider.waitReady")(function* (taskId: string) {
    while (true) {
      // RunTask can commit before DescribeTasks observes its ARN.
      const task = yield* resolve(taskId, "start").pipe(
        Effect.catchTags({
          TaskProviderError: (cause) =>
            cause.reason === "transport" ? Effect.void : Effect.fail(cause)
        })
      );
      if (task === undefined) {
        yield* Effect.sleep(500);
        continue;
      }
      if (task.value.lastStatus === "STOPPED")
        return yield* new TaskProvider.TaskProviderError({
          operation: "start",
          taskId,
          reason: "stopped"
        });
      if (yield* ready(task)) {
        if (!readiness.has(taskId)) readiness.set(taskId, yield* Clock.currentTimeMillis);
        return yield* observation(task, "start");
      }
      yield* Effect.sleep(500);
    }
  });
  const call = Effect.fn("EcsTaskProvider.call")(function* (
    taskId: string,
    operation: Operation,
    path: string,
    body: unknown
  ) {
    return yield* post(yield* resolve(taskId, operation), operation, path, body);
  });
  return TaskProvider.TaskProvider.of({
    start: (input) =>
      bounded(
        "start",
        input.taskId,
        Effect.gen(function* () {
          const revision = revisions.find(
            (entry) => entry.deploymentRevision === input.deploymentRevision
          );
          if (!validIdentity(input.taskId) || revision === undefined)
            return yield* new TaskProvider.TaskProviderError({
              operation: "start",
              taskId: input.taskId,
              reason: "provider"
            });
          const existing = (yield* inventory("start", input.taskId)).filter(
            (task) => task.taskId === input.taskId
          );
          if (
            existing.length > 1 ||
            (existing[0] !== undefined &&
              existing[0].deploymentRevision !== input.deploymentRevision)
          )
            return yield* new TaskProvider.TaskProviderError({
              operation: "start",
              taskId: input.taskId,
              reason: "binding_conflict"
            });
          if (existing.length === 0 && !addresses.has(input.taskId)) {
            const response = yield* aws(
              "start",
              input.taskId,
              client.runTask({
                cluster: options.cluster,
                taskDefinition: revision.taskDefinition,
                launchType: "FARGATE",
                platformVersion: "1.4.0",
                propagateTags: "TASK_DEFINITION",
                count: 1,
                clientToken: digest(`${options.fleetId}\0${input.taskId}`),
                startedBy,
                group,
                enableExecuteCommand: false,
                networkConfiguration: {
                  awsvpcConfiguration: {
                    subnets: [...options.subnetIds],
                    securityGroups: [options.bootstrapSecurityGroupId],
                    assignPublicIp: "DISABLED"
                  }
                },
                tags: [
                  { key: ownerTag, value: options.fleetId },
                  { key: roleTag, value: "exec" },
                  { key: taskTag, value: input.taskId },
                  { key: revisionTag, value: input.deploymentRevision }
                ],
                overrides: {
                  containerOverrides: [
                    {
                      name: containerName,
                      command: ["node", "dist/exec.js"],
                      environment: [
                        { name: "EXECUTION_TASK_ID", value: input.taskId },
                        {
                          name: "EXECUTION_DEPLOYMENT_REVISION",
                          value: input.deploymentRevision
                        },
                        {
                          name: "EXECUTION_MANAGEMENT_SECRET",
                          value: Redacted.value(revision.secret)
                        },
                        ...(revision !== options.current || options.previous === undefined
                          ? []
                          : [
                              {
                                name: "EXECUTION_MANAGEMENT_PREVIOUS_SECRET",
                                value: Redacted.value(options.previous.secret)
                              }
                            ]),
                        { name: "EXECUTION_MANAGEMENT_HOST", value: "auto" },
                        { name: "EXECUTION_MANAGEMENT_PORT", value: String(managementPort) },
                        { name: "EXECUTION_MANAGEMENT_PRIVATE_INTERFACE", value: "true" },
                        { name: "EXECUTION_CALLBACK_URLS", value: "[]" }
                      ]
                    }
                  ]
                }
              })
            );
            if (
              response.failures?.length ||
              response.tasks?.length !== 1 ||
              owned(response.tasks[0]!)?.taskId !== input.taskId
            )
              return yield* new TaskProvider.TaskProviderError({
                operation: "start",
                taskId: input.taskId,
                reason: "provider"
              });
          }
          return yield* waitReady(input.taskId);
        }),
        startupTimeout + managementTimeout
      ),
    list: bounded(
      "list",
      undefined,
      inventory("list").pipe(
        Effect.flatMap((tasks) => Effect.forEach(tasks, (task) => observation(task, "list")))
      ),
      startupTimeout
    ),
    quiesce: (taskId, bindingEpoch) =>
      bounded(
        "quiesce",
        taskId,
        call(taskId, "quiesce", "stop", { bindingEpoch }).pipe(Effect.asVoid)
      ),
    stop: (taskId) =>
      bounded(
        "stop",
        taskId,
        Effect.gen(function* () {
          let task = yield* resolve(taskId, "stop");
          if (task.value.lastStatus !== "STOPPED") {
            yield* aws(
              "stop",
              taskId,
              client.stopTask({
                cluster: options.cluster,
                task: task.value.taskArn!,
                reason: "Patchy execution controller released task"
              })
            );
            do {
              yield* Effect.sleep(500);
              task = yield* resolve(taskId, "stop");
            } while (task.value.lastStatus !== "STOPPED" || task.value.stoppedAt === undefined);
          }
          return yield* observation(task, "stop");
        }),
        120_000
      ),
    bind: (taskId, request) =>
      bounded(
        "bind",
        taskId,
        call(taskId, "bind", "bind", {
          ...request,
          callbackUrls: options.callbackUrls
        } satisfies Management.BindRequest).pipe(Effect.flatMap(decodeBind))
      ),
    invoke: (taskId, request) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* bounded(
          "invoke",
          taskId,
          call(taskId, "invoke", "invoke", request).pipe(Effect.flatMap(decodeInvoke)),
          Math.max(1, request.request.deadline - now) + managementTimeout
        );
      }),
    stats: (taskId, request) =>
      bounded(
        "stats",
        taskId,
        call(taskId, "stats", "stats", request).pipe(Effect.flatMap(decodeStats))
      )
  });
});

/** Only fleet hosts import this layer; local and exec entrypoints never load the AWS SDK. */
export const layer = (options?: Options) =>
  Layer.unwrap(
    (options === undefined ? config : Effect.succeed(options)).pipe(
      Effect.map((value) => Layer.effect(TaskProvider.TaskProvider, make(value)))
    )
  );
