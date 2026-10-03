import type * as Management from "@patchy/api/management";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TaskProvider from "../TaskProvider.js";

interface Entry {
  task: TaskProvider.Task;
  companyId: string | null;
  bindingEpoch: number;
  quiesced: boolean;
  final?: Management.StatsReply;
}

type Operation = TaskProvider.TaskProviderError["operation"];
const refuse = (
  operation: Operation,
  taskId: string,
  reason: TaskProvider.TaskProviderError["reason"]
) => new TaskProvider.TaskProviderError({ operation, taskId, reason });

/**
 * An in-memory task inventory that every host client shares, for fleet controller cases
 * that never run patch code. Each task's supervisor fences epochs like supervisor.ts: bind
 * refuses another company or an older epoch, quiesce and stats need the exact epoch, and a
 * stopped task answers stats from its final snapshot like the local task owner. Invoke and
 * bundle binds are refused; cases that execute code use the local provider.
 */
export const make = (): TaskProvider.TaskProvider["Service"] => {
  const tasks = new Map<string, Entry>();
  const snapshot = (entry: Entry): Management.StatsReply => ({
    companyId: entry.companyId,
    bindingEpoch: entry.bindingEpoch,
    stopped: entry.quiesced,
    aggregateRssBytes: 0,
    processes: [],
    reports: []
  });
  const running = (operation: Operation, taskId: string) =>
    Effect.suspend(() => {
      const entry = tasks.get(taskId);
      return entry?.task.state === "running"
        ? Effect.succeed(entry)
        : Effect.fail(refuse(operation, taskId, "stopped"));
    });
  return TaskProvider.TaskProvider.of({
    start: Effect.fnUntraced(function* ({ taskId, deploymentRevision }) {
      const existing = tasks.get(taskId);
      if (existing !== undefined)
        return existing.task.deploymentRevision === deploymentRevision
          ? existing.task
          : yield* refuse("start", taskId, "binding_conflict");
      const now = yield* Clock.currentTimeMillis;
      const task: TaskProvider.Task = {
        taskId,
        deploymentRevision,
        state: "running",
        startedAt: now,
        readyAt: now,
        stoppedAt: null
      };
      tasks.set(taskId, { task, companyId: null, bindingEpoch: 0, quiesced: false });
      return task;
    }),
    list: Effect.sync(() => [...tasks.values()].map((entry) => entry.task)),
    stop: Effect.fnUntraced(function* (taskId) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return yield* refuse("stop", taskId, "provider");
      if (entry.task.state === "running") {
        entry.final = { ...snapshot(entry), stopped: true };
        entry.task = { ...entry.task, state: "stopped", stoppedAt: yield* Clock.currentTimeMillis };
      }
      return entry.task;
    }),
    quiesce: Effect.fnUntraced(function* (taskId, bindingEpoch) {
      const entry = yield* running("quiesce", taskId);
      if (bindingEpoch !== entry.bindingEpoch)
        return yield* refuse("quiesce", taskId, "stale_epoch");
      entry.quiesced = true;
    }),
    bind: Effect.fnUntraced(function* (taskId, request) {
      const entry = yield* running("bind", taskId);
      if (entry.quiesced) return yield* refuse("bind", taskId, "stopped");
      if (entry.companyId !== null && entry.companyId !== request.companyId)
        return yield* refuse("bind", taskId, "binding_conflict");
      if (entry.companyId !== null && request.bindingEpoch < entry.bindingEpoch)
        return yield* refuse("bind", taskId, "stale_epoch");
      if (request.bundle !== undefined) return yield* refuse("bind", taskId, "provider");
      entry.companyId = request.companyId;
      entry.bindingEpoch = request.bindingEpoch;
      return { bindingEpoch: request.bindingEpoch };
    }),
    invoke: (taskId) => Effect.fail(refuse("invoke", taskId, "provider")),
    stats: Effect.fnUntraced(function* (taskId, request) {
      const entry = tasks.get(taskId);
      const current =
        entry === undefined
          ? undefined
          : entry.task.state === "stopped"
            ? entry.final
            : snapshot(entry);
      if (current === undefined) return yield* refuse("stats", taskId, "stopped");
      if (request.bindingEpoch !== current.bindingEpoch)
        return yield* refuse("stats", taskId, "stale_epoch");
      return current;
    })
  });
};
