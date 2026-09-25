// PROTOTYPE for #311: measurement 3, two simultaneous first opens against a
// pool of two, then a third with the pool empty.
import { invoke, admin, save, waitReady } from "./lib.mjs";
await waitReady(2);
const stamp = Date.now() % 100000;
const [a, b] = await Promise.all([
  invoke({ company: `sim${stamp}-a`, handler: "contacts.ping" }),
  invoke({ company: `sim${stamp}-b`, handler: "contacts.ping" })
]);
const c = await invoke({ company: `sim${stamp}-c`, handler: "contacts.ping" });
const out = {
  a: { ...a.timing, wallMs: a.wallMs, outcome: a.outcome },
  b: { ...b.timing, wallMs: b.wallMs, outcome: b.outcome },
  cEmptyPool: { ...c.timing, wallMs: c.wallMs, outcome: c.outcome },
  pool: await admin("/admin/pool")
};
console.log(JSON.stringify({ a: out.a, b: out.b, cEmptyPool: out.cEmptyPool }, null, 1));
save("03-simultaneous", out);
for (const k of ["a", "b", "c"]) await admin(`/admin/release?company=sim${stamp}-${k}`, "POST");
