// PROTOTYPE for #311: measurement 10, containment: the three probes from
// handler code, the supervisor's own view of the ENI, and the sealed-SG launch.
import { invoke, admin, save } from "./lib.mjs";
const out = { handler: {} };
for (const p of ["probe.metadata", "probe.fs", "probe.internet"]) {
  const r = await invoke({ company: "acme", handler: p });
  out.handler[p] = r.result ?? r.error;
  console.log(p, JSON.stringify(out.handler[p]));
}
out.supervisor = await admin("/admin/probe?company=acme");
console.log("supervisor:", JSON.stringify(out.supervisor, null, 1));
console.log("sealed SG launch (this waits for ECS to give up)...");
const t0 = Date.now();
out.sealed = await admin("/admin/sealed", "POST");
console.log("sealed:", JSON.stringify(out.sealed, null, 1), "waited", Date.now() - t0, "ms");
save("10-containment", out);
