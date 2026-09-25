// PROTOTYPE for #311 round 2: item 1, process per patch version beside one
// process per company. Runs the same-task interference, spawn-cost and memory
// measurements in the mode the pool is currently set to (see r2-01.sh).
import { invoke, admin, pct, header, row, save, sleep, waitReady } from "./lib.mjs";
const mode = process.argv[2] ?? "company";
const A = { company: "acme", patch: "crm" },
  B = { company: "acme", patch: "other" };
const out = { mode };
await admin("/admin/reset?company=acme", "POST");
await invoke({ ...B, handler: "contacts.ping" });
await invoke({ ...A, handler: "contacts.ping" });
const stats0 = await admin("/admin/stats?company=acme");
if (stats0.mode !== mode) throw new Error(`task is in mode ${stats0.mode}, wanted ${mode}`);
console.log(
  "mode",
  stats0.mode,
  "processes",
  stats0.processes,
  "aggregate RSS",
  stats0.aggregateRssMB,
  "MB"
);

// Same-task interference: B at ~20 req/s for the whole window; /stats every 250 ms.
async function interference(label, abuse, windowMs) {
  const t0 = Date.now();
  const b = [],
    statsLat = [];
  let aResult;
  const aP = abuse().then((r) => (aResult = r));
  const killedAt = { t: undefined };
  const bLoop = (async () => {
    while (Date.now() - t0 < windowMs) {
      const s = Date.now();
      invoke({ ...B, handler: "contacts.list" }).then((r) =>
        b.push({
          at: s - t0,
          ms: r.timing?.totalMs ?? r.wallMs,
          outcome: r.outcome ?? r.error,
          wall: r.wallMs
        })
      );
      await sleep(50);
    }
  })();
  const sLoop = (async () => {
    while (Date.now() - t0 < windowMs) {
      const s = Date.now();
      const st = await admin("/admin/stats?company=acme");
      statsLat.push({
        at: s - t0,
        ms: Date.now() - s,
        procs: st.processes,
        rss: st.aggregateRssMB
      });
      if (!killedAt.t && st.kills.length) killedAt.t = st.kills[st.kills.length - 1].at;
      await sleep(250);
    }
  })();
  await Promise.all([bLoop, sLoop, aP]);
  await sleep(1500);
  const st = await admin("/admin/stats?company=acme");
  const kill = st.kills[st.kills.length - 1];
  const during = b.filter((x) => kill && x.at + t0 < kill.at);
  const ok = b.filter((x) => x.outcome === "committed");
  const errors = b.filter((x) => x.outcome !== "committed");
  const firstOkAfterKill = kill
    ? b
        .filter((x) => x.outcome === "committed" && x.at + t0 > kill.at)
        .sort((p, q) => p.at - q.at)[0]
    : undefined;
  const r = {
    label,
    mode,
    windowMs,
    bRequests: b.length,
    bCommitted: ok.length,
    bErrors: errors.length,
    bErrorKinds: errors.reduce((m, x) => ({ ...m, [x.outcome]: (m[x.outcome] ?? 0) + 1 }), {}),
    bLatencyAll: pct(b.map((x) => x.ms)),
    bLatencyCommitted: pct(ok.map((x) => x.ms)),
    bLatencyBeforeKill: during.length ? pct(during.map((x) => x.ms)) : null,
    statsLatency: pct(statsLat.map((x) => x.ms)),
    statsMaxRssMB: Math.max(...statsLat.map((x) => x.rss)),
    kill: kill
      ? {
          reason: kill.reason,
          proc: kill.proc,
          detail: kill.detail,
          atMs: kill.at - t0,
          restartMs: kill.restartMs,
          inFlight: kill.inFlight.length
        }
      : null,
    recoveryMs: kill && firstOkAfterKill ? firstOkAfterKill.at + t0 - kill.at : null,
    aSaw: { outcome: aResult?.outcome, error: aResult?.error, totalMs: aResult?.timing?.totalMs }
  };
  console.log(JSON.stringify(r));
  return r;
}
out.loop = await interference("abuse.loop", () => invoke({ ...A, handler: "abuse.loop" }), 9000);
await sleep(2000);
out.alloc = await interference(
  "abuse.alloc x3",
  async () => {
    let r;
    for (let i = 0; i < 3; i++) r = await invoke({ ...A, handler: "abuse.alloc" });
    return r;
  },
  6000
);

// Spawn cost: first invoke of a not-yet-loaded version, v2..v20 (v1 is loaded).
const spawn = [];
for (let v = 2; v <= 20; v++) {
  const r = await invoke({ ...A, version: `v${v}`, handler: "contacts.ping" });
  spawn.push({
    version: `v${v}`,
    execMs: r.timing.execMs,
    spawnMs: r.timing.spawnMs,
    guestMs: r.timing.guestMs,
    firstLoad: r.timing.firstLoad,
    outcome: r.outcome
  });
}
const warm = [];
for (let v = 2; v <= 20; v++)
  warm.push((await invoke({ ...A, version: `v${v}`, handler: "contacts.ping" })).timing.execMs);
out.spawn = {
  firstInvokeExecMs: pct(spawn.map((s) => s.execMs)),
  spawnMs: pct(spawn.map((s) => s.spawnMs ?? 0)),
  secondInvokeExecMs: pct(warm),
  outcomes: [...new Set(spawn.map((s) => s.outcome))]
};
console.log(header(`${mode}: first invoke of a fresh version (n=19)`));
console.log(row("execMs (host to exec, incl. spawn+load)", out.spawn.firstInvokeExecMs));
console.log(row("spawnMs (supervisor)", out.spawn.spawnMs));
console.log(row("second invoke execMs", out.spawn.secondInvokeExecMs));

// Memory: aggregate RSS with 1, 5, 10, 20 versions loaded (each one warm invoke).
// Everything is already loaded from the spawn test, so wait for the reap, then reload in steps.
out.memory = [];
if (mode === "patch") {
  console.log("waiting 70 s for the idle reap...");
  await sleep(70_000);
  out.reapAfterIdle = (await admin("/admin/stats?company=acme")).processes;
  console.log("processes after idle window:", out.reapAfterIdle);
}
for (const n of [1, 5, 10, 20]) {
  for (let v = 1; v <= n; v++) await invoke({ ...A, version: `v${v}`, handler: "contacts.ping" });
  await sleep(1000);
  const st = await admin("/admin/stats?company=acme");
  out.memory.push({
    versionsLoaded: n,
    processes: st.processes,
    workerdRssMB: st.workerdRssMB,
    supervisorRssMB: st.supervisorRssMB,
    aggregateRssMB: st.aggregateRssMB
  });
  console.log(JSON.stringify(out.memory[out.memory.length - 1]));
}
save(`r2-01-${mode}`, out);
