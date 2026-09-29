// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off -- the offline provider uses private files and detached OS owners; deadlines and exits use wall time independently of TestClock.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import * as DeploymentConfig from "@patchy/limits/deployment-config";
import { registry } from "@patchy/limits/registry";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Store from "./localTaskStore.js";
import * as TaskProvider from "./TaskProvider.js";

const decodeBind = Schema.decodeUnknownEffect(Management.BindReply);
const decodeInvoke = Schema.decodeUnknownEffect(GuestProtocol.InvokeReply);
const decodeStats = Schema.decodeUnknownEffect(Management.StatsReply);
const decodeRefusal = Schema.decodeUnknownEffect(Management.Refusal);
const isProviderError = Schema.is(TaskProvider.TaskProviderError);
export interface Options {
  /** Same fleet means the same private local directory, including across host restarts. */
  readonly directory: string;
  /** Complete, stable callback allowlist for all hosts that can invoke this fleet. */
  readonly callbackUrls: readonly string[];
}
const killGrace = 5_000;
const filesystem = <A>(
  operation: TaskProvider.TaskProviderError["operation"],
  taskId: string | undefined,
  run: (signal: AbortSignal) => Promise<A>,
  timeout = registry["tier2.settlement.cleanup"].default + killGrace
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isProviderError(cause)
        ? cause
        : new TaskProvider.TaskProviderError({
            operation,
            ...(taskId === undefined ? {} : { taskId }),
            reason: "provider",
            cause
          })
  }).pipe(
    Effect.timeout(timeout),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new TaskProvider.TaskProviderError({
            operation,
            ...(taskId === undefined ? {} : { taskId }),
            reason: "transport",
            cause
          })
        )
    })
  );

/** Independently constructed clients share files and detached owners, never host-owned processes. */
export const make = Effect.fn("LocalTaskProvider.make")(function* (options: Options) {
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
  if (environment === "production")
    return yield* new TaskProvider.TaskProviderError({
      operation: "start",
      reason: "production_refused"
    });
  if (process.platform !== "linux")
    return yield* new TaskProvider.TaskProviderError({ operation: "start", reason: "provider" });
  const path = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
  const config = yield* DeploymentConfig.load;
  const startupTimeout = config.get("execution.pool.wait");
  const cleanupTimeout = registry["tier2.settlement.cleanup"].default;
  const managementTimeout = cleanupTimeout + killGrace;
  const http = yield* HttpClient.HttpClient;
  const directory = resolve(options.directory);
  yield* filesystem("list", undefined, () => mkdir(directory, { recursive: true, mode: 0o700 }));

  const launch = async (taskDirectory: string, record: Store.Record | undefined) => {
    if (
      record?.task.state === "stopped" ||
      (record !== undefined && (await Store.alive(record.owner)))
    )
      return;
    const source = import.meta.url.endsWith(".ts");
    await new Promise<void>((resolve, reject) => {
      // --no-fork keeps the lock in the detached owner itself. Competing launches lose the lock.
      const child = spawn(
        "flock",
        [
          "--exclusive",
          "--nonblock",
          "--no-fork",
          join(taskDirectory, "owner.lock"),
          process.execPath,
          ...(source ? ["--import", "tsx", "--conditions=development"] : []),
          fileURLToPath(
            new URL(source ? "./localTaskOwner.ts" : "./localTaskOwner.js", import.meta.url)
          ),
          taskDirectory
        ],
        { detached: true, stdio: "ignore", env: { PATH: path, NODE_ENV: "test" } }
      );
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };
  const waitFor = async (
    taskDirectory: string,
    signal: AbortSignal,
    deadline: number,
    accept: (record: Store.Record) => boolean
  ) => {
    while (true) {
      const record = await Store.readRecord(taskDirectory);
      if (record !== undefined && accept(record)) return record;
      if (Date.now() >= deadline) throw new Error("Local task observation timed out");
      await delay(20, undefined, { signal });
    }
  };
  const current = (taskId: string, operation: TaskProvider.TaskProviderError["operation"]) =>
    filesystem(operation, taskId, async (signal) => {
      const taskDirectory = Store.taskDirectory(directory, taskId);
      const request = await Store.readRequest(taskDirectory);
      if (request === undefined)
        throw new TaskProvider.TaskProviderError({ operation, taskId, reason: "stopped" });
      const record = await Store.readRecord(taskDirectory);
      await launch(taskDirectory, record);
      return waitFor(
        taskDirectory,
        signal,
        Date.now() + managementTimeout,
        (value) => value.task.state === "stopped" || value.url !== null
      );
    });
  const stop = Effect.fn("LocalTaskProvider.stop")(function* (taskId: string) {
    return yield* filesystem("stop", taskId, async (signal) => {
      const taskDirectory = Store.taskDirectory(directory, taskId);
      if ((await Store.readRequest(taskDirectory)) === undefined)
        throw new TaskProvider.TaskProviderError({ operation: "stop", taskId, reason: "provider" });
      // A stop survives cancelled callers and later start retries. Only the owner certifies exit.
      await writeFile(join(taskDirectory, "stop"), "", { mode: 0o600 });
      await launch(taskDirectory, await Store.readRecord(taskDirectory));
      const record = await waitFor(
        taskDirectory,
        signal,
        Date.now() + managementTimeout,
        (value) => value.task.state === "stopped"
      );
      return record.task;
    });
  });
  const post = Effect.fn("LocalTaskProvider.post")(function* (
    taskId: string,
    operation: "bind" | "invoke" | "stats",
    body: unknown
  ) {
    const record = yield* current(taskId, operation);
    if (record.task.state === "stopped")
      return yield* new TaskProvider.TaskProviderError({ operation, taskId, reason: "stopped" });
    const request = yield* filesystem(operation, taskId, () =>
      Store.readRequest(Store.taskDirectory(directory, taskId))
    );
    const response = yield* http
      .execute(
        HttpClientRequest.post(`${record.url}/${operation}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${request!.secret}`),
          HttpClientRequest.bodyJsonUnsafe(body)
        )
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new TaskProvider.TaskProviderError({
              operation,
              taskId,
              reason: "transport",
              cause
            })
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
  const bounded = <A, E>(
    operation: "bind" | "invoke" | "stats",
    taskId: string,
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
              taskId,
              reason: Cause.isTimeoutError(cause) ? "transport" : "protocol",
              cause
            })
      )
    );
  return TaskProvider.TaskProvider.of({
    start: (input) =>
      filesystem(
        "start",
        input.taskId,
        async (signal) => {
          const taskDirectory = Store.taskDirectory(directory, input.taskId);
          const request = await Store.createRequest(taskDirectory, {
            ...input,
            callbackUrls: options.callbackUrls,
            secret: randomUUID(),
            path,
            startupTimeout,
            cleanupTimeout,
            startedAt: Date.now()
          });
          if (request.deploymentRevision !== input.deploymentRevision)
            throw new TaskProvider.TaskProviderError({
              operation: "start",
              taskId: input.taskId,
              reason: "binding_conflict"
            });
          const existing = await Store.readRecord(taskDirectory);
          if (existing?.task.state === "stopped") return existing.task;
          await launch(taskDirectory, existing);
          const record = await waitFor(
            taskDirectory,
            signal,
            Date.now() + startupTimeout + managementTimeout,
            (value) => value.task.state === "stopped" || value.url !== null
          );
          if (record.task.readyAt === 0)
            throw new TaskProvider.TaskProviderError({
              operation: "start",
              taskId: input.taskId,
              reason: "provider",
              cause: new Error("Local task exited before readiness")
            });
          return record.task;
        },
        startupTimeout + managementTimeout
      ),
    list: filesystem("list", undefined, async () => {
      const tasks: TaskProvider.Task[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const taskDirectory = join(directory, entry.name);
        const request = await Store.readRequest(taskDirectory);
        if (request === undefined) continue;
        const record = await Store.readRecord(taskDirectory);
        await launch(taskDirectory, record);
        tasks.push(
          record?.task ?? {
            taskId: request.taskId,
            deploymentRevision: request.deploymentRevision,
            state: "running",
            startedAt: request.startedAt,
            readyAt: 0,
            stoppedAt: null
          }
        );
      }
      return tasks;
    }),
    stop,
    bind: (taskId, request) =>
      bounded("bind", taskId, post(taskId, "bind", request).pipe(Effect.flatMap(decodeBind))),
    invoke: (taskId, request) =>
      bounded(
        "invoke",
        taskId,
        post(taskId, "invoke", request).pipe(Effect.flatMap(decodeInvoke)),
        Math.max(1, request.request.deadline - Date.now()) + managementTimeout
      ),
    stats: (taskId, request) =>
      bounded(
        "stats",
        taskId,
        Effect.gen(function* () {
          const record = yield* current(taskId, "stats");
          if (record.task.state !== "stopped")
            return yield* post(taskId, "stats", request).pipe(Effect.flatMap(decodeStats));
          if (record.finalStats === undefined)
            return yield* new TaskProvider.TaskProviderError({
              operation: "stats",
              taskId,
              reason: "stopped"
            });
          if (request.bindingEpoch !== record.bindingEpoch)
            return yield* new TaskProvider.TaskProviderError({
              operation: "stats",
              taskId,
              reason: "stale_epoch"
            });
          const finalStats = record.finalStats;
          return yield* filesystem("stats", taskId, async () => {
            const taskDirectory = Store.taskDirectory(directory, taskId);
            const acknowledged = new Set(request.acknowledgeReports ?? []);
            // Additive acknowledgement markers avoid cross-host read/modify/write races.
            for (const report of finalStats.reports) {
              if (acknowledged.has(report.reportId))
                await writeFile(
                  join(taskDirectory, `ack-${Buffer.from(report.reportId).toString("hex")}`),
                  "",
                  { mode: 0o600 }
                );
            }
            const files = new Set(await readdir(taskDirectory));
            return {
              ...finalStats,
              reports: finalStats.reports.filter(
                (report) => !files.has(`ack-${Buffer.from(report.reportId).toString("hex")}`)
              )
            };
          });
        })
      )
  });
});

/** Explicit test/resource ownership. Closing a host client never stops shared tasks. */
export const resource = Effect.fn("LocalTaskProvider.resource")(function* (
  options: Omit<Options, "directory">
) {
  const directory = yield* filesystem("start", undefined, () =>
    mkdtemp(join(tmpdir(), "patchy-local-fleet-"))
  );
  const shared = { ...options, directory };
  yield* Effect.addFinalizer(() => cleanup(directory).pipe(Effect.orDie));
  return shared;
});

/** The owner of a disposable local fleet, not an individual host, calls this after closing its hosts. */
export const cleanup = Effect.fn("LocalTaskProvider.cleanup")(function* (directory: string) {
  const provider = yield* make({ directory, callbackUrls: [] });
  const tasks = yield* provider.list;
  yield* Effect.forEach(tasks, (task) => provider.stop(task.taskId), {
    concurrency: "unbounded",
    discard: true
  });
  yield* filesystem("stop", undefined, () => rm(directory, { recursive: true, force: true }));
});
export const layer = (options: Options) => Layer.effect(TaskProvider.TaskProvider, make(options));
