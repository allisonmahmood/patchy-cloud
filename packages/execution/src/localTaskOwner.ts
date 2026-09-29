// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- standalone Linux process owner survives the host and is serialized by flock.
import { fork } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import * as Store from "./localTaskStore.js";

const decodeReady = Schema.decodeUnknownSync(Store.Ready);
const decodeFinal = Schema.decodeUnknownSync(Store.Final);
const isReady = Schema.is(Store.Ready);
const isFinal = Schema.is(Store.Final);
const directory = process.argv[2]!;

async function main(): Promise<void> {
  const request = await Store.readRequest(directory);
  if (request === undefined) return;
  const previous = await Store.readRecord(directory);
  if (previous?.task.state === "stopped") return;
  if (previous !== undefined) {
    // The OS lock proves the old owner is gone, not that its supervisor has exited.
    if (previous.child === null)
      throw new Error("Unobserved local task startup; retaining its slot");
    if (await Store.alive(previous.child)) {
      process.kill(-previous.child.pid, "SIGKILL");
      const deadline = Date.now() + 5_000;
      while ((await Store.groupMembers(previous.child)).length !== 0) {
        if (Date.now() >= deadline) throw new Error("Local task group has not exited");
        await delay(20);
      }
    } else if ((await Store.groupMembers(previous.child)).length !== 0) {
      // Without an exact live identity, an old group number is not authority to kill.
      throw new Error("Unobserved local task descendants; retaining its slot");
    }
    await Store.writeRecord(directory, {
      ...previous,
      task: { ...previous.task, state: "stopped", stoppedAt: Date.now() }
    });
    return;
  }
  let record: Store.Record = {
    task: {
      taskId: request.taskId,
      deploymentRevision: request.deploymentRevision,
      state: "running",
      startedAt: request.startedAt,
      readyAt: 0,
      stoppedAt: null
    },
    owner: (await Store.processIdentity(process.pid))!,
    child: null,
    url: null,
    bindingEpoch: 0
  };
  await Store.writeRecord(directory, record);
  const source = import.meta.url.endsWith(".ts");
  const child = fork(
    fileURLToPath(new URL(source ? "./localTask.ts" : "./localTask.js", import.meta.url)),
    [],
    {
      execArgv: source ? ["--import", "tsx", "--conditions=development"] : [],
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        PATH: request.path,
        NODE_ENV: "test",
        EXECUTION_MANAGEMENT_SECRET: request.secret,
        EXECUTION_MANAGEMENT_HOST: "127.0.0.1",
        EXECUTION_MANAGEMENT_PORT: "0",
        EXECUTION_CALLBACK_URLS: JSON.stringify(request.callbackUrls),
        EXECUTION_DEPLOYMENT_REVISION: request.deploymentRevision,
        EXECUTION_TASK_ID: request.taskId
      }
    }
  );
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      resolve();
    });
  });
  let failed = false;
  child.on("error", () => {
    failed = true;
  });
  // Publish child identity before allowing its initialize handshake to start work.
  let update = (async () => {
    const identity = child.pid === undefined ? null : await Store.processIdentity(child.pid);
    record = { ...record, child: identity };
    await Store.writeRecord(directory, record);
  })();
  child.on("message", (message) => {
    // IPC writes are serialized so the final record cannot overtake readiness.
    update = update
      .then(async () => {
        if (message === "initialize") {
          if (child.connected) child.send("start");
          return;
        }
        if (isReady(message)) {
          const { url } = decodeReady(message);
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
            failed = true;
            return;
          }
          record = { ...record, url, task: { ...record.task, readyAt: Date.now() } };
          await Store.writeRecord(directory, record);
        } else if (isFinal(message)) {
          record = { ...record, ...decodeFinal(message) };
          await Store.writeRecord(directory, record);
        }
      })
      .catch(() => {
        failed = true;
      });
  });
  await update;
  const startupDeadline = Date.now() + request.startupTimeout;
  while (!exited && !failed) {
    try {
      await access(join(directory, "stop"));
      break;
    } catch (cause) {
      if (!Store.missing(cause)) throw cause;
    }
    if (record.url === null && Date.now() >= startupDeadline) break;
    await delay(20);
  }
  if (!exited) {
    if (child.connected && record.url !== null) child.send("stop");
    const gracefulDeadline = Date.now() + (record.url === null ? 0 : request.cleanupTimeout);
    while (!exited && Date.now() < gracefulDeadline) await delay(20);
    if (!exited && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
      }
    }
  }
  await exit;
  await update;
  if (record.child !== null && record.finalStats === undefined) {
    // This owner observed the exit itself. Reap descendants left by an abrupt supervisor exit.
    for (const member of await Store.groupMembers(record.child)) {
      if (await Store.alive(member)) process.kill(member.pid, "SIGKILL");
    }
    const deadline = Date.now() + 5_000;
    while ((await Store.groupMembers(record.child)).length !== 0) {
      if (Date.now() >= deadline) throw new Error("Local task descendants have not exited");
      await delay(20);
    }
  }
  await Store.writeRecord(directory, {
    ...record,
    task: { ...record.task, state: "stopped", stoppedAt: Date.now() }
  });
}

void main().catch(() => {
  // An unknown exit is not a confirmed stop. Another provider recovers under the OS lock.
  process.exitCode = 1;
  process.disconnect?.();
});
