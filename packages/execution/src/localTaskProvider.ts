// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off globalTimersInEffect:off preferSchemaOverJson:off -- this offline provider owns OS child lifetimes and records their observed exit time independently of TestClock.
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import * as DeploymentConfig from "@patchy/limits/deployment-config";
import { registry } from "@patchy/limits/registry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as TaskProvider from "./TaskProvider.js";

const decodeReady = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }));
const decodeBind = Schema.decodeUnknownEffect(Management.BindReply);
const decodeInvoke = Schema.decodeUnknownEffect(GuestProtocol.InvokeReply);
const decodeStats = Schema.decodeUnknownEffect(Management.StatsReply);
const decodeRefusal = Schema.decodeUnknownEffect(Management.Refusal);
const isProviderError = Schema.is(TaskProvider.TaskProviderError);
interface Running {
  task: TaskProvider.Task;
  readonly child: ChildProcess;
  readonly secret: string;
  readonly ready: Promise<string>;
  readonly exited: Promise<void>;
  bindingEpoch: number;
  finalStats?: Management.StatsReply;
}
export interface Options {
  readonly callbackUrls: readonly string[];
}

/** Real processes stand in for tasks. This provider is deliberately unavailable in production. */
export const make = Effect.fn("LocalTaskProvider.make")(function* (options: Options) {
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
  const path = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
  const config = yield* DeploymentConfig.load;
  if (environment === "production")
    return yield* new TaskProvider.TaskProviderError({
      operation: "start",
      reason: "production_refused"
    });
  const http = yield* HttpClient.HttpClient;
  const tasks = new Map<string, Running>();
  const stop = Effect.fn("LocalTaskProvider.stop")(function* (taskId: string) {
    const task = tasks.get(taskId);
    if (task === undefined)
      return yield* new TaskProvider.TaskProviderError({
        operation: "stop",
        taskId,
        reason: "provider"
      });
    if (task.task.state !== "stopped") {
      const captured = yield* Effect.gen(function* () {
        const url = yield* Effect.tryPromise(() => task.ready);
        const response = yield* http.execute(
          HttpClientRequest.post(`${url}/stop`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${task.secret}`),
            HttpClientRequest.bodyJsonUnsafe({ bindingEpoch: task.bindingEpoch })
          )
        );
        if (response.status !== 204)
          return yield* new TaskProvider.TaskProviderError({
            operation: "stop",
            taskId,
            reason: "protocol"
          });
        return yield* decodeStats(
          yield* post(taskId, "stats", { bindingEpoch: task.bindingEpoch })
        );
      }).pipe(Effect.timeout(registry["tier2.settlement.cleanup"].default), Effect.result);
      if (captured._tag === "Success") task.finalStats = captured.success;
    }
    yield* Effect.promise(async () => {
      if (task.task.state === "stopped") return;
      task.child.kill("SIGTERM");
      const timer = setTimeout(() => {
        // A wedged supervisor cannot retain its workerd children after provider stop.
        if (task.child.pid !== undefined) {
          try {
            process.kill(-task.child.pid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
      }, 5_000);
      try {
        await task.exited;
      } finally {
        clearTimeout(timer);
      }
    });
    return task.task;
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(tasks.keys(), (id) => stop(id).pipe(Effect.orDie), {
      concurrency: "unbounded",
      discard: true
    })
  );

  const start = Effect.fn("LocalTaskProvider.start")(function* (input: {
    readonly taskId: string;
    readonly deploymentRevision: string;
  }) {
    let task = tasks.get(input.taskId);
    if (task !== undefined && task.task.deploymentRevision !== input.deploymentRevision)
      return yield* new TaskProvider.TaskProviderError({
        operation: "start",
        taskId: input.taskId,
        reason: "binding_conflict"
      });
    if (task === undefined) {
      task = yield* Effect.try({
        try: () => {
          const secret = randomUUID();
          const startedAt = Date.now();
          const source = import.meta.url.endsWith(".ts");
          const child = fork(
            fileURLToPath(new URL(source ? "./localTask.ts" : "./localTask.js", import.meta.url)),
            [],
            {
              execArgv: source ? ["--import", "tsx", "--conditions=development"] : [],
              detached: true,
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              env: {
                PATH: path,
                NODE_ENV: "test",
                EXECUTION_MANAGEMENT_SECRET: secret,
                EXECUTION_MANAGEMENT_HOST: "127.0.0.1",
                EXECUTION_MANAGEMENT_PORT: "0",
                EXECUTION_CALLBACK_URLS: JSON.stringify(options.callbackUrls),
                EXECUTION_DEPLOYMENT_REVISION: input.deploymentRevision,
                EXECUTION_TASK_ID: input.taskId
              }
            }
          );
          const exited = new Promise<void>((resolve) => {
            child.once("close", () => {
              record.task = { ...record.task, state: "stopped", stoppedAt: Date.now() };
              resolve();
            });
          });
          const ready = new Promise<string>((resolve, reject) => {
            let settled = false;
            const fail = (cause: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (child.pid !== undefined) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  // A failed spawn or exited process may already be reaped.
                }
              }
              void exited.then(() => reject(cause));
            };
            const timer = setTimeout(
              () => fail(new Error("Local task startup timed out")),
              config.get("execution.pool.wait")
            );
            child.once("error", fail);
            child.once("exit", () => fail(new Error("Local task exited before readiness")));
            child.once("message", (message) => {
              if (settled) return;
              try {
                const { url } = decodeReady(message);
                const parsed = new URL(url);
                if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
                  throw new Error("Nonlocal task listener");
                record.task = { ...record.task, readyAt: Date.now() };
                settled = true;
                resolve(url);
              } catch (cause) {
                fail(cause);
              } finally {
                clearTimeout(timer);
              }
            });
            child.once("close", () => clearTimeout(timer));
          });
          const record: Running = {
            child,
            secret,
            ready,
            exited,
            bindingEpoch: 0,
            task: { ...input, state: "running", startedAt, readyAt: startedAt, stoppedAt: null }
          };
          // A cancelled waiter does not cancel or replace the provider's task identity.
          void ready.catch(() => undefined);
          tasks.set(input.taskId, record);
          return record;
        },
        catch: (cause) =>
          new TaskProvider.TaskProviderError({
            operation: "start",
            taskId: input.taskId,
            reason: "provider",
            cause
          })
      });
    }
    const current = task;
    yield* Effect.tryPromise({
      try: () => current.ready,
      catch: (cause) =>
        new TaskProvider.TaskProviderError({
          operation: "start",
          taskId: input.taskId,
          reason: "provider",
          cause
        })
    });
    return current.task;
  });
  const post = Effect.fn("LocalTaskProvider.post")(function* (
    taskId: string,
    operation: "bind" | "invoke" | "stats",
    body: unknown
  ) {
    const task = tasks.get(taskId);
    if (task === undefined || task.task.state === "stopped")
      return yield* new TaskProvider.TaskProviderError({ operation, taskId, reason: "stopped" });
    const url = yield* Effect.tryPromise({
      try: () => task.ready,
      catch: (cause) =>
        new TaskProvider.TaskProviderError({ operation, taskId, reason: "transport", cause })
    });
    const response = yield* http
      .execute(
        HttpClientRequest.post(`${url}/${operation}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${task.secret}`),
          HttpClientRequest.bodyJsonUnsafe(body)
        )
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new TaskProvider.TaskProviderError({ operation, taskId, reason: "transport", cause })
        )
      );
    const value = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new TaskProvider.TaskProviderError({ operation, taskId, reason: "protocol", cause })
      )
    );
    if (response.status !== 200) {
      const refusal = yield* decodeRefusal(value).pipe(
        Effect.mapError(
          (cause) =>
            new TaskProvider.TaskProviderError({ operation, taskId, reason: "protocol", cause })
        )
      );
      return yield* new TaskProvider.TaskProviderError({
        operation,
        taskId,
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
    return value;
  });
  return TaskProvider.TaskProvider.of({
    start,
    list: Effect.sync(() => Array.from(tasks.values(), ({ task }) => task)),
    stop,
    bind: (taskId, request) =>
      post(taskId, "bind", request).pipe(
        Effect.flatMap(decodeBind),
        Effect.tap(() =>
          Effect.sync(() => {
            const task = tasks.get(taskId);
            if (task !== undefined)
              task.bindingEpoch = Math.max(task.bindingEpoch, request.bindingEpoch);
          })
        ),
        Effect.mapError((cause) =>
          isProviderError(cause)
            ? cause
            : new TaskProvider.TaskProviderError({
                operation: "bind",
                taskId,
                reason: "protocol",
                cause
              })
        )
      ),
    invoke: (taskId, request) =>
      post(taskId, "invoke", request).pipe(
        Effect.flatMap(decodeInvoke),
        Effect.mapError((cause) =>
          isProviderError(cause)
            ? cause
            : new TaskProvider.TaskProviderError({
                operation: "invoke",
                taskId,
                reason: "protocol",
                cause
              })
        )
      ),
    stats: (taskId, request) =>
      Effect.suspend(() => {
        const task = tasks.get(taskId);
        if (task?.task.state === "stopped" && task.finalStats !== undefined) {
          if (request.bindingEpoch !== task.bindingEpoch)
            return Effect.fail(
              new TaskProvider.TaskProviderError({
                operation: "stats",
                taskId,
                reason: "stale_epoch"
              })
            );
          const acknowledged = new Set(request.acknowledgeReports ?? []);
          task.finalStats = {
            ...task.finalStats,
            reports: task.finalStats.reports.filter((report) => !acknowledged.has(report.reportId))
          };
          return Effect.succeed(task.finalStats);
        }
        return post(taskId, "stats", request).pipe(
          Effect.flatMap(decodeStats),
          Effect.mapError((cause) =>
            isProviderError(cause)
              ? cause
              : new TaskProvider.TaskProviderError({
                  operation: "stats",
                  taskId,
                  reason: "protocol",
                  cause
                })
          )
        );
      })
  });
});
export const layer = (options: Options) => Layer.effect(TaskProvider.TaskProvider, make(options));
