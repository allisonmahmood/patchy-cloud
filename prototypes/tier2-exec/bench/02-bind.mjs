// PROTOTYPE for #311: measurement 2, bind time on a pre-started task: first
// open for a fresh company (bind + first invoke), n=5, then release them.
import { invoke, admin, pct, header, row, save, waitReady } from "./lib.mjs";
const runs = [];
for (let i = 0; i < 5; i++) {
  await waitReady(1);
  const company = `bind${Date.now() % 100000}-${i}`;
  const r = await invoke({ company, handler: "contacts.ping" });
  console.log(company, JSON.stringify(r.timing), "wall", r.wallMs);
  runs.push({ company, ...r.timing, wallMs: r.wallMs });
  await admin(`/admin/release?company=${company}`, "POST");
}
save("02-bind", runs);
console.log(header("first open on a pre-started task (ms)"));
for (const k of ["bindMs", "bindLoadMs", "execMs", "totalMs", "wallMs"])
  console.log(row(k, pct(runs.map((r) => r[k]))));
