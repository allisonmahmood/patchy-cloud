// PROTOTYPE for #311 round 2: item 4, ownership transitions. Two companies
// bound, slow invocations in flight, then the host service is forced onto a
// new deployment. The new host must adopt the bindings from the pool_tasks
// table, the supervisors must refuse the old host's later requests as stale,
// and ecs list-tasks must match the table afterwards.
import { execFileSync } from "node:child_process";
import { invoke, admin, H, save, sleep } from "./lib.mjs";
const cluster = process.env.SPIKE_ECS_CLUSTER;
const out = {};
await admin("/admin/reset?company=acme", "POST");
await invoke({ company: "acme", handler: "contacts.ping" });
await invoke({ company: "beta", handler: "contacts.ping" });
const before = await admin("/admin/echo");
out.before = {
  epoch: before.epoch,
  pool: (await admin("/admin/pool")).tasks.map((t) => ({
    id: t.id,
    state: t.state,
    company: t.company,
    arn: t.arn?.split("/").pop()
  }))
};
console.log("before:", JSON.stringify(out.before));

// Keep slow invocations in flight throughout the rollout; each reply says which host answered.
const samples = [];
let stop = false;
const loop = (async () => {
  let i = 0;
  while (!stop) {
    const company = i++ % 2 ? "beta" : "acme";
    const s = Date.now();
    const r = await fetch(`${H}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-viewer": "allison" },
      body: JSON.stringify({ company, handler: "contacts.slow", args: { ms: 3000 } })
    })
      .then(async (x) => ({ hostEpoch: x.headers.get("x-host-epoch"), ...(await x.json()) }))
      .catch((e) => ({ outcome: `fetch_error ${e.cause?.code ?? e.message}` }));
    samples.push({
      at: s - t0,
      company,
      hostEpoch: r.hostEpoch,
      outcome: r.outcome ?? r.error,
      totalMs: r.timing?.totalMs,
      error: r.error
    });
    await sleep(700);
  }
})();
const t0 = Date.now();
await sleep(2000);
console.log("forcing a new deployment of tier2-spike-host...");
execFileSync("aws", [
  "ecs",
  "update-service",
  "--cluster",
  cluster,
  "--service",
  "tier2-spike-host",
  "--force-new-deployment",
  "--query",
  "service.deployments[0].id",
  "--output",
  "text"
]);
// Wait until a reply comes from a higher epoch, then keep sampling for 60 s so the drain and SIGTERM of the old host are covered.
let newEpoch;
while (!newEpoch) {
  await sleep(1000);
  newEpoch = samples.find((s) => Number(s.hostEpoch) > before.epoch)?.hostEpoch;
  if (Date.now() - t0 > 300_000) break;
}
console.log("first reply from the new host (epoch", newEpoch, ") at", Date.now() - t0, "ms");
await sleep(75_000);
stop = true;
await loop;
execFileSync("aws", [
  "ecs",
  "wait",
  "services-stable",
  "--cluster",
  cluster,
  "--services",
  "tier2-spike-host"
]);
const after = await admin("/admin/echo");
const pool = await admin("/admin/pool");
out.after = {
  epoch: after.epoch,
  adoptedTasks: pool.tasks.map((t) => ({
    id: t.id,
    state: t.state,
    company: t.company,
    adopted: t.adopted,
    arn: t.arn?.split("/").pop()
  }))
};
// ecs list-tasks vs the table.
const running = JSON.parse(
  execFileSync("aws", [
    "ecs",
    "list-tasks",
    "--cluster",
    cluster,
    "--family",
    "tier2-spike-exec",
    "--query",
    "taskArns",
    "--output",
    "json"
  ]).toString()
).map((a) => a.split("/").pop());
out.ecsExecTasks = running;
out.tableTasks = pool.tasks.map((t) => t.arn?.split("/").pop());
out.match =
  running.length === out.tableTasks.length && running.every((a) => out.tableTasks.includes(a));
// The mutation key committed by the previous host replays from the table (item 3c).
const replay = await invoke({
  company: "acme",
  handler: "contacts.createMany",
  args: { prefix: "key-host" },
  key: "k-host-replacement"
});
out.keyReplayAfterHostReplacement = {
  outcome: replay.outcome,
  deduplicated: replay.deduplicated ?? null,
  result: replay.result,
  rows: (await admin("/admin/rows?company=acme&like=key-host-%")).named.length,
  hostEpoch: replay.hostEpoch
};
// Both companies still bound and answering.
out.afterInvokes = {
  acme: (await invoke({ company: "acme", handler: "contacts.list" })).outcome,
  beta: (await invoke({ company: "beta", handler: "contacts.ping" })).outcome
};
out.samples = samples;
const byEpoch = samples.reduce((m, s) => {
  const k = `${s.hostEpoch}:${s.outcome}`;
  m[k] = (m[k] ?? 0) + 1;
  return m;
}, {});
out.summary = {
  samples: samples.length,
  byEpochAndOutcome: byEpoch,
  staleOwner: samples
    .filter((s) => s.outcome === "stale_owner")
    .map((s) => ({ at: s.at, hostEpoch: s.hostEpoch, error: s.error })),
  oldHostLast: samples.filter((s) => Number(s.hostEpoch) === before.epoch).slice(-3),
  newHostFirst: samples.filter((s) => Number(s.hostEpoch) > before.epoch).slice(0, 3)
};
console.log(
  JSON.stringify(
    {
      after: out.after,
      ecs: out.ecsExecTasks,
      table: out.tableTasks,
      match: out.match,
      keyReplay: out.keyReplayAfterHostReplacement,
      afterInvokes: out.afterInvokes,
      summary: out.summary
    },
    null,
    1
  )
);
save("r2-04-ownership", out);
