// PROTOTYPE for #311: the wake path's pool manager. Keeps POOL_SIZE pre-started,
// unbound exec tasks; binds one to a company on first open; releases (stops) it
// when the company is idle for IDLE_MS. A task is never reassigned across
// companies. Local mode: EXEC_URLS lists static supervisors instead of ECS.
import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  StopTaskCommand
} from "@aws-sdk/client-ecs";

export type Task = {
  id: string;
  arn?: string;
  url?: string;
  state: "starting" | "ready" | "bound" | "stopping";
  company?: string;
  generation?: number;
  loaded: Set<string>;
  lastUsed: number;
  times: {
    runTask: number;
    running?: number;
    healthy?: number;
    bound?: number;
    bindMs?: number;
    firstInvoke?: number;
    stopped?: number;
  };
  error?: string;
};

const POOL_SIZE = Number(process.env.POOL_SIZE ?? 2);
const IDLE_MS = Number(process.env.IDLE_MS ?? 60_000);
const LOCAL = (process.env.EXEC_URLS ?? "").split(",").filter(Boolean);
const ecs = new ECSClient({ region: "us-east-1" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const tasks: Task[] = [];
export const history: Task[] = [];
const binding = new Map<string, Promise<Task>>();
let seq = 0;

export function runTaskParams(overrides: { securityGroup?: string } = {}) {
  return {
    cluster: process.env.SPIKE_ECS_CLUSTER!,
    taskDefinition: process.env.EXEC_TASK_DEF!,
    launchType: "FARGATE" as const,
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [process.env.SPIKE_PRIVATE_SUBNET!],
        securityGroups: [overrides.securityGroup ?? process.env.SPIKE_SG_EXEC_BOOTSTRAP!],
        assignPublicIp: "DISABLED" as const
      }
    }
  };
}

export async function describe(arn: string) {
  const d = await ecs.send(
    new DescribeTasksCommand({ cluster: process.env.SPIKE_ECS_CLUSTER!, tasks: [arn] })
  );
  return d.tasks?.[0];
}

async function waitHealthy(url: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("exec task never became healthy");
    await sleep(100);
  }
}

// RunTask -> RUNNING -> supervisor healthy. Returns the task; timings inside.
export async function startTask(
  opts: { securityGroup?: string; track?: boolean } = {}
): Promise<Task> {
  const task: Task = {
    id: `t${++seq}`,
    state: "starting",
    loaded: new Set(),
    lastUsed: Date.now(),
    times: { runTask: Date.now() }
  };
  if (opts.track !== false) tasks.push(task);
  try {
    if (LOCAL.length) {
      const used = new Set(tasks.filter((t) => t !== task).map((t) => t.url));
      task.url = LOCAL.find((u) => !used.has(u));
      if (!task.url) throw new Error("no free local exec");
      task.times.running = Date.now();
    } else {
      const r = await ecs.send(new RunTaskCommand(runTaskParams(opts)));
      if (!r.tasks?.length) throw new Error(`RunTask failed: ${JSON.stringify(r.failures)}`);
      task.arn = r.tasks[0].taskArn;
      for (;;) {
        await sleep(500);
        const t = await describe(task.arn!);
        if (t?.lastStatus === "STOPPED")
          throw new Error(
            `task stopped: ${t.stoppedReason} ${JSON.stringify(t.containers?.map((c) => c.reason))}`
          );
        if (t?.lastStatus === "RUNNING") {
          const ip = t.attachments?.[0]?.details?.find(
            (d) => d.name === "privateIPv4Address"
          )?.value;
          task.url = `http://${ip}:8080`;
          task.times.running = Date.now();
          break;
        }
      }
    }
    await waitHealthy(task.url!);
    task.times.healthy = Date.now();
    task.state = "ready";
    console.log(
      `[pool] ${task.id} ready: running +${task.times.running! - task.times.runTask} ms, healthy +${task.times.healthy - task.times.runTask} ms (${task.url})`
    );
  } catch (e: any) {
    task.error = e.message;
    task.state = "stopping";
    console.log(`[pool] ${task.id} failed: ${e.message}`);
    remove(task);
    throw e;
  }
  return task;
}

function remove(task: Task) {
  const i = tasks.indexOf(task);
  if (i >= 0) tasks.splice(i, 1);
  history.push(task);
}

export async function stopTask(task: Task, reason = "released") {
  task.state = "stopping";
  remove(task);
  task.times.stopped = Date.now();
  if (task.arn)
    await ecs.send(
      new StopTaskCommand({ cluster: process.env.SPIKE_ECS_CLUSTER!, task: task.arn, reason })
    );
  console.log(`[pool] ${task.id} stopped (${reason}) company=${task.company}`);
}

export function ensure() {
  const spare = tasks.filter((t) => t.state === "starting" || t.state === "ready").length;
  for (let i = spare; i < POOL_SIZE; i++) startTask().then(ensure, () => {});
}

// First open for a company: bind a ready task, or wait for one that is starting,
// or start one now when the pool is empty.
export function acquire(company: string, bind: (task: Task) => Promise<void>): Promise<Task> {
  const bound = tasks.find((t) => t.state === "bound" && t.company === company);
  if (bound) {
    bound.lastUsed = Date.now();
    return Promise.resolve(bound);
  }
  const inProgress = binding.get(company);
  if (inProgress) return inProgress;
  const p = (async () => {
    let task = tasks.find((t) => t.state === "ready");
    if (!task) {
      task = tasks.find((t) => t.state === "starting" && !t.company);
      if (task) {
        task.company = company; // claim it while it starts
        while (task.state === "starting") await sleep(50);
        if (task.state !== "ready") throw new Error(task.error ?? "task failed while starting");
      } else {
        task = await startTask();
      }
    }
    task.company = company;
    task.state = "bound";
    ensure();
    const t0 = Date.now();
    await bind(task);
    task.times.bound = Date.now();
    task.times.bindMs = Date.now() - t0;
    task.lastUsed = Date.now();
    return task;
  })().finally(() => binding.delete(company));
  binding.set(company, p);
  return p;
}

export function release(company: string) {
  return Promise.all(
    tasks.filter((t) => t.state === "bound" && t.company === company).map((t) => stopTask(t))
  );
}

export function start() {
  ensure();
  setInterval(() => {
    for (const t of tasks)
      if (t.state === "bound" && Date.now() - t.lastUsed > IDLE_MS)
        stopTask(t, "idle").then(ensure);
  }, 5000);
}

export function snapshot() {
  const rel = (t: Task) => ({
    ...t,
    loaded: [...t.loaded],
    times: Object.fromEntries(
      Object.entries(t.times).map(([k, v]) => [
        k,
        k === "runTask" || k === "bindMs" ? v : (v as number) - t.times.runTask
      ])
    )
  });
  return { poolSize: POOL_SIZE, idleMs: IDLE_MS, tasks: tasks.map(rel), history: history.map(rel) };
}
