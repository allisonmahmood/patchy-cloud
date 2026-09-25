// PROTOTYPE for #311: measurement 9, the bad neighbour. abuse.loop / alloc in
// patch A while patch B (same company, same task) and company C (other task)
// serve pings; what B and C saw, watchdog reaction, what A's caller saw.
import { invoke, admin, pct, header, row, save, sleep } from "./lib.mjs";
const A = { company: "acme", patch: "crm" },
  B = { company: "acme", patch: "other" },
  C = { company: "cee", patch: "crm" };
await invoke({ ...B, handler: "contacts.ping" });
await invoke({ ...C, handler: "contacts.ping" });
const baseline = { B: [], C: [] };
for (let i = 0; i < 20; i++) {
  baseline.B.push((await invoke({ ...B, handler: "contacts.ping" })).timing.totalMs);
  baseline.C.push((await invoke({ ...C, handler: "contacts.ping" })).timing.totalMs);
}
console.log(header("baseline ping totalMs"));
console.log(row("B (same task)", pct(baseline.B)));
console.log(row("C (other task)", pct(baseline.C)));

async function during(label, abuse) {
  const t0 = Date.now();
  const aP = abuse();
  const samples = [];
  const tick = async () => {
    const at = Date.now() - t0;
    const [b, c] = await Promise.all([
      invoke({ ...B, handler: "contacts.ping" }),
      invoke({ ...C, handler: "contacts.ping" })
    ]);
    samples.push({
      at,
      B: { outcome: b.outcome ?? b.error, ms: b.timing?.totalMs ?? b.wallMs },
      C: { outcome: c.outcome ?? c.error, ms: c.timing?.totalMs ?? c.wallMs }
    });
  };
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    ticks.push(tick());
    await sleep(500);
  }
  const a = await aP;
  await Promise.all(ticks);
  const stats = await admin("/admin/stats?company=acme");
  const out = {
    label,
    A: { outcome: a.outcome, error: a.error, totalMs: a.timing?.totalMs, kill: a.timing?.kill },
    samples,
    kills: stats.kills,
    generation: stats.generation,
    workerdRssMB: stats.workerdRssMB
  };
  console.log(label, JSON.stringify(out, null, 1));
  return out;
}
const loop = await during("abuse.loop", () => invoke({ ...A, handler: "abuse.loop" }));
await sleep(1000);
const alloc = await during("abuse.alloc x3", async () => {
  let r;
  for (let i = 0; i < 3; i++) {
    r = await invoke({ ...A, handler: "abuse.alloc" });
    console.log(
      "alloc",
      i,
      r.outcome,
      JSON.stringify(r.result ?? r.error),
      (await admin("/admin/stats?company=acme")).workerdRssMB,
      "MB"
    );
  }
  return r;
});
save("09-neighbour", { baseline, loop, alloc });
