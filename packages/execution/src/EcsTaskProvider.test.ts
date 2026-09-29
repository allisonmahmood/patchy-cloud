// @effect-diagnostics globalDate:off globalDateInEffect:off -- SDK fixtures carry Date timestamps derived from TestClock.
import type { Task, TaskDefinition } from "@aws-sdk/client-ecs";
import { assert, it } from "@effect/vitest";
import * as WideEvents from "@patchy/analytics/wide-events";
import { OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Ecs from "./ecs.js";
import * as EcsTaskProvider from "./ecsTaskProvider.js";
import * as Fleet from "./fleet.js";
import * as TaskProvider from "./TaskProvider.js";

// Synthetic account, never a real deployment identifier.
const arnPrefix = `arn:aws:ecs:us-east-1:${"0".repeat(12)}`;
const options: EcsTaskProvider.Options = {
  region: "us-east-1",
  cluster: "test-cluster",
  fleetId: "test-fleet",
  subnetIds: ["subnet-private"],
  bootstrapSecurityGroupId: "sg-private",
  current: {
    deploymentRevision: "current",
    taskDefinition: `${arnPrefix}:task-definition/exec:2`,
    secret: Redacted.make("current-test-secret")
  },
  previous: {
    deploymentRevision: "previous",
    taskDefinition: `${arnPrefix}:task-definition/exec:1`,
    secret: Redacted.make("previous-test-secret")
  },
  callbackUrls: ["http://10.0.0.1:8787/callback"]
};
const revisions = [options.current, options.previous!];

// Alternate external-service layer: ECS retains tasks and idempotency tokens across host clients.
// HTTP authentication is checked against the task's revision, not echoed from each request.
const cloud = Effect.gen(function* () {
  const tasks = new Map<string, Task>();
  const tokens = new Map<string, string>();
  const omitted = new Set<string>();
  const missing = new Set<string>();
  const failedStops = new Set<string>();
  const stopped = yield* Queue.unbounded<string>();
  const definitions = new Map<string, TaskDefinition>(
    revisions.map((revision) => [
      revision.taskDefinition,
      {
        taskDefinitionArn: revision.taskDefinition,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        containerDefinitions: [{ name: "exec", user: "0" }]
      }
    ])
  );
  const supervisors = new Map<
    string,
    {
      revision: string;
      companyId: string | null;
      bindingEpoch: number;
      stopped: boolean;
    }
  >();
  let loseRunReply = false;
  const ecs = Ecs.Ecs.of({
    describeTaskDefinition: (input) =>
      Effect.succeed({
        $metadata: {},
        taskDefinition: definitions.get(input.taskDefinition!)!
      }),
    listTasks: (input) =>
      Effect.sync(() => ({
        $metadata: {},
        taskArns: [...tasks.entries()]
          .filter(
            ([arn, task]) =>
              !omitted.has(arn) &&
              (input.desiredStatus === "STOPPED"
                ? task.lastStatus === "STOPPED"
                : task.lastStatus !== "STOPPED")
          )
          .map(([arn]) => arn)
      })),
    describeTasks: (input) =>
      Effect.sync(() => ({
        $metadata: {},
        tasks: (input.tasks ?? []).flatMap((arn) => {
          const task = tasks.get(arn);
          return task && !missing.has(arn) ? [task] : [];
        }),
        failures: (input.tasks ?? [])
          .filter((arn) => missing.has(arn) || !tasks.has(arn))
          .map((arn) => ({ arn, reason: "MISSING" }))
      })),
    runTask: Effect.fn("TestEcs.runTask")(function* (input) {
      const existing = tokens.get(input.clientToken!);
      if (existing) return { $metadata: {}, tasks: [tasks.get(existing)!] };
      const now = yield* Clock.currentTimeMillis;
      const arn = `${arnPrefix}:task/test-cluster/${tasks.size + 1}`;
      const address = `10.0.1.${tasks.size + 1}`;
      const revision = input.tags!.find((tag) => tag.key === "patchy:deployment-revision")!.value!;
      const task: Task = {
        taskArn: arn,
        taskDefinitionArn: input.taskDefinition,
        startedBy: input.startedBy,
        group: input.group,
        tags: input.tags,
        createdAt: new Date(now),
        startedAt: new Date(now),
        lastStatus: "RUNNING",
        attachments: [
          {
            type: "ElasticNetworkInterface",
            details: [{ name: "privateIPv4Address", value: address }]
          }
        ]
      };
      tasks.set(arn, task);
      tokens.set(input.clientToken!, arn);
      supervisors.set(address, { revision, companyId: null, bindingEpoch: 0, stopped: false });
      if (loseRunReply) {
        loseRunReply = false;
        omitted.add(arn);
        return yield* new Ecs.EcsError({
          operation: "runTask",
          cause: new Error("Acknowledgement lost")
        });
      }
      return { $metadata: {}, tasks: [task] };
    }),
    stopTask: Effect.fn("TestEcs.stopTask")(function* (input) {
      const arn = input.task!;
      if (failedStops.has(arn))
        return yield* new Ecs.EcsError({
          operation: "stopTask",
          cause: new Error("ECS unavailable")
        });
      const task = tasks.get(arn)!;
      task.lastStatus = "STOPPED";
      task.stoppedAt = new Date(yield* Clock.currentTimeMillis);
      yield* Queue.offer(stopped, arn);
      return { $metadata: {}, task };
    })
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const supervisor = supervisors.get(url.hostname)!;
      const accepted = supervisor.revision === "current" ? revisions : [options.previous!];
      if (
        !accepted.some(
          (revision) =>
            request.headers.authorization === `Bearer ${Redacted.value(revision.secret)}`
        )
      )
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ ok: false, code: "unauthorized" }, { status: 401 })
        );
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              companyId?: string;
              bindingEpoch: number;
            })
          : { bindingEpoch: 0 };
      if (url.pathname === "/bind") {
        supervisor.companyId = body.companyId!;
        supervisor.bindingEpoch = body.bindingEpoch;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ bindingEpoch: body.bindingEpoch })
        );
      }
      if (url.pathname === "/stop") {
        supervisor.stopped = true;
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          companyId: supervisor.companyId,
          bindingEpoch: supervisor.bindingEpoch,
          stopped: supervisor.stopped,
          aggregateRssBytes: 0,
          processes: [],
          reports: []
        })
      );
    })
  );
  return {
    tasks,
    omitted,
    missing,
    failedStops,
    stopped,
    definitions,
    loseRunReply: () => {
      loseRunReply = true;
    },
    layer: Layer.merge(Layer.succeed(Ecs.Ecs, ecs), Layer.succeed(HttpClient.HttpClient, http))
  };
});

for (const revision of revisions) {
  const invalidDefinitions: ReadonlyArray<
    [string, (definition: TaskDefinition) => TaskDefinition]
  > = [
    ["task role", (definition) => ({ ...definition, taskRoleArn: "credentialed-role" })],
    [
      "secret",
      (definition) => ({
        ...definition,
        containerDefinitions: [
          { name: "exec", user: "0", secrets: [{ name: "TOKEN", valueFrom: "secret" }] }
        ]
      })
    ],
    [
      "environment file",
      (definition) => ({
        ...definition,
        containerDefinitions: [
          { name: "exec", user: "0", environmentFiles: [{ type: "s3", value: "object" }] }
        ]
      })
    ],
    [
      "AWS credentials",
      (definition) => ({
        ...definition,
        containerDefinitions: [
          { name: "exec", user: "0", environment: [{ name: "AWS_ACCESS_KEY_ID", value: "unsafe" }] }
        ]
      })
    ],
    [
      "ECS credentials",
      (definition) => ({
        ...definition,
        containerDefinitions: [
          {
            name: "exec",
            user: "0",
            environment: [{ name: "ECS_CONTAINER_CREDENTIALS_RELATIVE_URI", value: "/unsafe" }]
          }
        ]
      })
    ],
    [
      "image default user",
      (definition) => ({ ...definition, containerDefinitions: [{ name: "exec" }] })
    ],
    [
      "nonroot user",
      (definition) => ({ ...definition, containerDefinitions: [{ name: "exec", user: "node" }] })
    ]
  ];
  for (const [name, invalidate] of invalidDefinitions) {
    it.effect(
      `rejects ${name} in the ${revision.deploymentRevision} definition before launch`,
      () =>
        Effect.gen(function* () {
          const aws = yield* cloud;
          aws.definitions.set(
            revision.taskDefinition,
            invalidate(aws.definitions.get(revision.taskDefinition)!)
          );
          const error = yield* EcsTaskProvider.make(options).pipe(
            Effect.provide(aws.layer),
            Effect.flip
          );
          assert.instanceOf(error, TaskProvider.TaskProviderError);
          assert.include(error, { operation: "start", reason: "provider" });
          assert.strictEqual(aws.tasks.size, 0);
        })
    );
  }
}

it.effect("retains known ARNs through omitted listings and treats MISSING as uncertainty", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000_000);
    const aws = yield* cloud;
    const provider = yield* EcsTaskProvider.make(options).pipe(Effect.provide(aws.layer));
    const task = yield* provider.start({ taskId: "known", deploymentRevision: "current" });
    const arn = [...aws.tasks.keys()][0]!;
    aws.omitted.add(arn);
    assert.deepEqual(yield* provider.list, [task]);
    aws.missing.add(arn);
    assert.deepEqual(yield* provider.list, []);
    assert.include(yield* provider.stop(task.taskId).pipe(Effect.flip), { reason: "transport" });
    assert.strictEqual(aws.tasks.get(arn)!.lastStatus, "RUNNING");
    aws.missing.clear();
    assert.deepEqual(yield* provider.list, [task]);
  })
);

it.effect(
  "retries ambiguous starts idempotently across host replacement and refuses foreign tasks",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const aws = yield* cloud;
      const firstHost = yield* EcsTaskProvider.make(options).pipe(Effect.provide(aws.layer));
      aws.loseRunReply();
      assert.include(
        yield* firstHost
          .start({ taskId: "ambiguous", deploymentRevision: "current" })
          .pipe(Effect.flip),
        { reason: "provider" }
      );
      const secondHost = yield* EcsTaskProvider.make(options).pipe(Effect.provide(aws.layer));
      const started = yield* secondHost.start({
        taskId: "ambiguous",
        deploymentRevision: "current"
      });
      assert.include(started, { taskId: "ambiguous", state: "running" });
      assert.strictEqual(aws.tasks.size, 1);
      const owned = [...aws.tasks.values()][0]!;
      const foreign: ReadonlyArray<Partial<Task>> = [
        { tags: owned.tags!.filter((tag) => tag.key !== "patchy:execution-fleet") },
        { startedBy: "another-host" },
        { group: "another-fleet" },
        { taskDefinitionArn: `${arnPrefix}:task-definition/other:1` }
      ];
      foreign.forEach((changes, index) => {
        const taskArn = `${arnPrefix}:task/test-cluster/foreign-${index}`;
        aws.tasks.set(taskArn, { ...owned, ...changes, taskArn });
      });
      assert.deepEqual(yield* secondHost.list, [started]);
      assert.include(
        yield* secondHost
          .start({ taskId: "ambiguous", deploymentRevision: "previous" })
          .pipe(Effect.flip),
        { reason: "binding_conflict" }
      );
      assert.strictEqual(
        [...aws.tasks.values()].filter((task) => task.lastStatus === "RUNNING").length,
        5
      );
    })
);

it.effect(
  "authenticates each managed revision and lets retained hosts reach the promoted supervisor",
  () =>
    Effect.gen(function* () {
      const aws = yield* cloud;
      const provider = yield* EcsTaskProvider.make(options).pipe(Effect.provide(aws.layer));
      for (const revision of revisions) {
        const taskId = revision.deploymentRevision;
        yield* provider.start({ taskId, deploymentRevision: taskId });
        yield* provider.bind(taskId, { companyId: `company-${taskId}`, bindingEpoch: 1 });
        assert.include(yield* provider.stats(taskId, { bindingEpoch: 1 }), {
          companyId: `company-${taskId}`,
          bindingEpoch: 1
        });
      }
      const { previous, ...withoutPrevious } = options;
      const oldHost = yield* EcsTaskProvider.make({ ...withoutPrevious, current: previous! }).pipe(
        Effect.provide(aws.layer)
      );
      assert.include(yield* oldHost.stats("current", { bindingEpoch: 1 }), {
        companyId: "company-current"
      });
    })
);

const services = OperatingLimits.layer.pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.merge(WideEvents.layerNoop)
);
const setupFleet = Effect.fn("EcsFleetTest.setup")(function* () {
  yield* TestClock.setTime(1_000_000);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE execution_deployments, execution_housekeeping, execution_breakers CASCADE`;
  yield* sql`INSERT INTO execution_rollout(singleton) VALUES (true)`;
  const aws = yield* cloud;
  const host = Effect.fn("EcsFleetTest.host")(function* (replicaId: string) {
    const provider = yield* EcsTaskProvider.make(options).pipe(Effect.provide(aws.layer));
    const controller = yield* Fleet.make({
      replicaId,
      deploymentRevision: "current",
      automaticHousekeeping: false
    }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
    return { provider, controller };
  });
  const first = yield* host("first");
  yield* first.controller.housekeeping();
  return { aws, sql, host, ...first };
});
const budget = (size: number, spares = 2) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PATCHY_LIMITS_JSON: JSON.stringify({
        "execution.fleet.budget": size,
        "execution.pool.spares": spares,
        "execution.pool.wakeWindow": 100_000
      })
    })
  );

it.layer(services)("ECS fleet reconciliation", (it) => {
  it.effect(
    "keeps durable live tasks and their budget through omissions, MISSING and host replacement",
    () =>
      Effect.gen(function* () {
        const { aws, sql, host, controller } = yield* setupFleet();
        const arn = [...aws.tasks.keys()][0]!;
        aws.omitted.add(arn);
        yield* controller.housekeeping();
        aws.missing.add(arn);
        yield* controller.housekeeping();
        yield* sql`DELETE FROM execution_housekeeping`;
        const replacement = yield* host("replacement");
        yield* replacement.controller.housekeeping();
        assert.strictEqual(
          (yield* sql`SELECT task_id FROM execution_tasks WHERE state <> 'stopped'`).length,
          2
        );
        assert.strictEqual(
          [...aws.tasks.values()].filter((task) => task.lastStatus === "RUNNING").length,
          2
        );
        aws.omitted.clear();
        aws.missing.clear();
        yield* replacement.controller.housekeeping();
        assert.strictEqual(
          (yield* replacement.provider.list).filter((task) => task.state === "running").length,
          2
        );
        assert.strictEqual(aws.tasks.size, 2);
        assert.deepEqual(yield* Queue.takeBetween(aws.stopped, 0, Number.POSITIVE_INFINITY), []);
        // An explicit drain also needs positive exit evidence, not an absent list entry.
        const taskId = aws.tasks
          .get(arn)!
          .tags!.find((tag) => tag.key === "patchy:execution-task")!.value!;
        aws.omitted.add(arn);
        aws.missing.add(arn);
        yield* replacement.controller.drainTask(taskId).pipe(Effect.flip);
        assert.deepEqual(yield* sql`SELECT state FROM execution_tasks WHERE task_id = ${taskId}`, [
          { state: "stopping" }
        ]);
      }).pipe(Effect.scoped, Effect.provide(budget(2)))
  );

  it.effect(
    "fences a reappearing stopped row before replenishment and retries its stop after replacement",
    () =>
      Effect.gen(function* () {
        const { aws, sql, host, controller } = yield* setupFleet();
        const arn = [...aws.tasks.keys()][0]!;
        const taskId = aws.tasks
          .get(arn)!
          .tags!.find((tag) => tag.key === "patchy:execution-task")!.value!;
        yield* sql`UPDATE execution_tasks SET state = 'stopped', stopped_at = 999999 WHERE task_id = ${taskId}`;
        aws.failedStops.add(arn);
        yield* controller.housekeeping();
        assert.deepEqual(
          yield* sql`SELECT state, stopped_at FROM execution_tasks WHERE task_id = ${taskId}`,
          [{ state: "stopping", stopped_at: null }]
        );
        assert.strictEqual(aws.tasks.size, 2);
        yield* sql`DELETE FROM execution_housekeeping`;
        const replacement = yield* host("replacement");
        aws.omitted.add(arn);
        aws.missing.add(arn);
        yield* replacement.controller.housekeeping();
        assert.strictEqual(
          (yield* sql`SELECT task_id FROM execution_tasks WHERE state <> 'stopped'`).length,
          2
        );
        assert.strictEqual(aws.tasks.size, 2);
        aws.failedStops.clear();
        aws.omitted.clear();
        aws.missing.clear();
        const recovering = yield* replacement.controller.housekeeping().pipe(Effect.forkChild);
        assert.strictEqual(yield* Queue.take(aws.stopped), arn);
        yield* TestClock.adjust(500);
        yield* Fiber.join(recovering);
        assert.deepEqual(yield* sql`SELECT state FROM execution_tasks WHERE task_id = ${taskId}`, [
          { state: "stopped" }
        ]);
        yield* replacement.controller.housekeeping();
        assert.strictEqual(
          [...aws.tasks.values()].filter((task) => task.lastStatus === "RUNNING").length,
          2
        );
        assert.strictEqual(aws.tasks.size, 3);
      }).pipe(Effect.scoped, Effect.provide(budget(2)))
  );

  it.effect(
    "sizes spares from durable request-to-ready latency without changing ECS usage timestamps",
    () =>
      Effect.gen(function* () {
        const { sql, controller } = yield* setupFleet();
        for (let index = 0; index < 3; index++) {
          const companyId = `ecs-cold-${index}`;
          yield* sql`INSERT INTO companies(id, handle, name) VALUES (${companyId}, ${companyId}, 'Cold start test')`;
          yield* controller.ensureBinding(companyId);
          yield* controller.housekeeping();
        }
        yield* sql`UPDATE execution_tasks SET requested_at = 920000, started_at = 999000, ready_at = 1000000`;
        yield* controller.housekeeping();
        // Three wakes / 100 seconds * 80 seconds request-to-ready requires three spares.
        // Measuring only the one second RUNNING-to-ready interval would leave one.
        assert.strictEqual(
          (yield* sql`SELECT task_id FROM execution_tasks WHERE state = 'spare'`).length,
          3
        );
        assert.strictEqual(
          (yield* sql`SELECT task_id FROM execution_tasks WHERE state = 'bound' AND started_at = 999000`)
            .length,
          3
        );
      }).pipe(Effect.scoped, Effect.provide(budget(8, 1)))
  );
});
