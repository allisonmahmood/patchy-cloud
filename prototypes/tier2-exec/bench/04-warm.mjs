// PROTOTYPE for #311: measurement 4, warm invocation: no callbacks (ping) and
// one callback (list), n=100 each. Host-side timing plus laptop wall time.
import { invoke, admin, pct, header, row, save } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
await invoke({ company: "acme", handler: "contacts.ping" });
const out = {};
for (const handler of ["contacts.ping", "contacts.list"]) {
  const runs = [];
  for (let i = 0; i < 100; i++) runs.push(await invoke({ company: "acme", handler }));
  out[handler] = runs.map((r) => ({ ...r.timing, wallMs: r.wallMs, outcome: r.outcome }));
  console.log(header(`${handler} (ms)`));
  for (const k of ["execMs", "guestMs", "callbackMs", "sqlMs", "beginRowMs", "totalMs", "wallMs"])
    console.log(row(k, pct(out[handler].map((r) => r[k] ?? 0))));
  console.log("outcomes", [...new Set(out[handler].map((r) => r.outcome))]);
}
save("04-warm", out);
