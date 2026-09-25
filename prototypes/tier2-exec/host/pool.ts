// PROTOTYPE for #311: the wake path's pool manager. Keeps POOL_SIZE pre-started,
// unbound exec tasks; binds one to a company on first open; releases (stops) it
// when the company is idle for IDLE_MS. A task is never reassigned across
// companies. Local mode: EXEC_URLS lists static supervisors instead of ECS.
//
// Round 2: the pool state lives in the `pool_tasks` table with this host's
// owner epoch; a replacement host adopts the rows (verifying each task) and
// claims the tasks with its higher epoch, so the old host's late requests are
// refused by the supervisor as stale. Every exec call carries the shared
// secret and the epoch.
import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  StopTaskCommand
} from "@aws-sdk/client-ecs";
import { pool as db } from "./db.ts";

export type Task = {
  id: string;
  arn?: string;
  url?: string;
  state: "starting" | "ready" | "bound" | "stopping";
  company?: string;
  generation?: number;
  loaded: Set<string>;
  lastUsed: number;
  adopted?: boolean;
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
const SECRET = process.env.EXEC_SECRET ?? "";
export let processMode = process.env.EXEC_PROCESS_MODE ?? "company";
export let epoch = 0;
const ecs = new ECSClient({ region: "us-east-1" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const tasks: Task[] = [];
export const history: Task[] = [];
const binding = new Map<string, Promise<Task>>();
let seq = 0;

export const setEpoch = (e: number) => (epoch = e);
// Set when any supervisor answered 412 stale_epoch: a newer host owns the
// tasks now, so this host must stop starting, stopping or binding anything.
export let superseded = false;
export const markSuperseded = () => (superseded = true);
export const setProcessMode = (m: string) => (processMode = m);
export const execHeaders = () => ({
  "content-type": "application/json",
  "x-exec-secret": SECRET,
  "x-owner-epoch": String(epoch)
});
const key = (t: Task) => t.arn ?? t.url!;

async function persist(t: Task) {
  if (t.state === "stopping")
    return db.query("delete from pool_tasks where task_arn = $1", [key(t)]).catch(() => {});
  return db
    .query(
      `insert into pool_tasks (task_arn, url, state, company, owner_epoch, process_mode, run_task_at, ready_at, bound_at, last_used)
       values ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0))
       on conflict (task_arn) do update set url = excluded.url, state = excluded.state, company = excluded.company, owner_epoch = excluded.owner_epoch,
         ready_at = excluded.ready_at, bound_at = excluded.bound_at, last_used = excluded.last_used`,
      [
        key(t),
        t.url ?? null,
        t.state,
        t.company ?? null,
        epoch,
        processMode,
        t.times.runTask,
        t.times.healthy ?? null,
        t.times.bound ?? null,
        t.lastUsed
      ]
    )
    .catch((e) => console.log(`[pool] persist failed: ${e.message}`));
}

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
    },
    overrides: {
      containerOverrides: [
        { name: "exec", environment: [{ name: "PROCESS_MODE", value: processMode }] }
      ]
    }
  };
}

export async function describe(arn: string) {
  const d = await ecs.send(
    new DescribeTasksCommand({ cluster: process.env.SPIKE_ECS_CLUSTER!, tasks: [arn] })
  );
  return d.tasks?.[0];
}

async function healthy(url: string) {
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(url: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (!(await healthy(url))) {
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
      if (opts.track !== false) await persist(task);
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
    if (opts.track !== false) await persist(task);
    console.log(
      `[pool] ${task.id} ready: running +${task.times.running! - task.times.runTask} ms, healthy +${task.times.healthy - task.times.runTask} ms (${task.url})`
    );
  } catch (e: any) {
    task.error = e.message;
    task.state = "stopping";
    console.log(`[pool] ${task.id} failed: ${e.message}`);
    remove(task);
    await persist(task);
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
  remove(task);
  // Fence the ECS call on the table: a row owned by a higher epoch is not ours to stop.
  const owner = (
    await db.query("select owner_epoch from pool_tasks where task_arn = $1", [key(task)])
  ).rows[0]?.owner_epoch;
  if (superseded || (owner !== undefined && Number(owner) > epoch)) {
    console.log(
      `[pool] ${task.id} NOT stopped (${reason}): owned by epoch ${owner ?? "?"}, this host is epoch ${epoch}${superseded ? ", superseded" : ""}`
    );
    return;
  }
  task.state = "stopping";
  remove(task);
  task.times.stopped = Date.now();
  await persist(task);
  if (task.arn)
    await ecs.send(
      new StopTaskCommand({ cluster: process.env.SPIKE_ECS_CLUSTER!, task: task.arn, reason })
    );
  console.log(`[pool] ${task.id} stopped (${reason}) company=${task.company}`);
}

export function ensure() {
  if (superseded) return;
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
    await persist(task);
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

// Stop the unbound tasks so the pool refills (used to switch PROCESS_MODE).
export function drainReady() {
  return Promise.all(tasks.filter((t) => t.state === "ready").map((t) => stopTask(t, "drained")));
}

export function stopAll(reason: string) {
  return Promise.all([...tasks].map((t) => stopTask(t, reason)));
}

// A replacement host takes over the previous host's tasks: verify each row's
// task is RUNNING and healthy, then claim it with this host's epoch.
export async function adopt() {
  const rows = (await db.query("select * from pool_tasks order by run_task_at")).rows;
  const report: Array<{ task: string; company: string | null; state: string; result: string }> = [];
  for (const r of rows) {
    let ok = false;
    if (LOCAL.length) ok = !!r.url && (await healthy(r.url));
    else {
      const t = await describe(r.task_arn).catch(() => undefined);
      ok = t?.lastStatus === "RUNNING" && !!r.url && (await healthy(r.url));
    }
    if (!ok || r.state === "starting") {
      report.push({
        task: r.task_arn,
        company: r.company,
        state: r.state,
        result: "dropped (not running/healthy)"
      });
      await db.query("delete from pool_tasks where task_arn = $1", [r.task_arn]);
      continue;
    }
    const task: Task = {
      id: `t${++seq}`,
      arn: LOCAL.length ? undefined : r.task_arn,
      url: r.url,
      state: r.state,
      company: r.company ?? undefined,
      loaded: new Set(),
      lastUsed: Date.now(),
      adopted: true,
      times: {
        runTask: new Date(r.run_task_at).getTime(),
        healthy: r.ready_at ? new Date(r.ready_at).getTime() : undefined,
        bound: r.bound_at ? new Date(r.bound_at).getTime() : undefined
      }
    };
    tasks.push(task);
    // Claim: the supervisor records the higher epoch and refuses the old host from now on.
    const claim = await fetch(`${task.url}/epoch`, {
      headers: execHeaders(),
      signal: AbortSignal.timeout(2000)
    })
      .then((x) => x.json())
      .catch((e) => ({ error: e.message }));
    await persist(task);
    report.push({
      task: r.task_arn,
      company: r.company,
      state: r.state,
      result: `adopted from epoch ${r.owner_epoch}; supervisor now at ${claim.highestEpoch ?? claim.error}`
    });
  }
  console.log(
    `[pool] epoch ${epoch} adopted ${tasks.length} of ${rows.length} rows: ${JSON.stringify(report)}`
  );
  return report;
}

export function start() {
  ensure();
  setInterval(() => {
    if (superseded) return;
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
  return {
    epoch,
    superseded,
    processMode,
    poolSize: POOL_SIZE,
    idleMs: IDLE_MS,
    tasks: tasks.map(rel),
    history: history.map(rel)
  };
}
