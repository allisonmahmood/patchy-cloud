// PROTOTYPE for #311: measurement 8, workerd RSS at idle and with 1, 10, 50
// concurrent slow queries in flight on one task (slot cap raised for this).
import { invoke, admin, save, sleep } from "./lib.mjs";
await admin("/admin/slots?n=64", "POST");
await invoke({ company: "acme", handler: "contacts.ping" });
await sleep(1500);
const idle = await admin("/admin/stats?company=acme");
const out = {
  idle: {
    workerdRssMB: idle.workerdRssMB,
    supervisorRssMB: idle.supervisorRssMB,
    generation: idle.generation
  },
  runs: []
};
console.log("idle", JSON.stringify(out.idle));
for (const n of [1, 10, 50]) {
  const ps = Array.from({ length: n }, () =>
    invoke({ company: "acme", handler: "contacts.slow", args: { ms: 4000 } })
  );
  await sleep(2000);
  const s = await admin("/admin/stats?company=acme");
  const rs = await Promise.all(ps);
  const r = {
    concurrent: n,
    inFlightSeen: s.inFlight,
    workerdRssMB: s.workerdRssMB,
    supervisorRssMB: s.supervisorRssMB,
    perInvocationMB: +((s.workerdRssMB - out.idle.workerdRssMB) / n).toFixed(2),
    outcomes: rs.reduce(
      (m, x) => ({ ...m, [x.outcome ?? x.error]: (m[x.outcome ?? x.error] ?? 0) + 1 }),
      {}
    )
  };
  console.log(JSON.stringify(r));
  out.runs.push(r);
  await sleep(1500);
}
await admin("/admin/slots?n=4", "POST");
save("08-memory", out);
