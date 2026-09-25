// PROTOTYPE for #311: measurement 1, cold start. RunTask -> RUNNING -> healthy
// -> bind -> first invoke on a fresh task outside the pool, n=3.
import { admin, pct, header, row, save } from "./lib.mjs";
const runs = [];
for (let i = 0; i < 3; i++) {
  const r = await admin("/admin/coldstart?company=cold", "POST");
  console.log(JSON.stringify(r));
  runs.push(r);
}
save("01-coldstart", runs);
console.log(header("cold start (ms, host-side)"));
for (const k of [
  "runTaskToRunningMs",
  "runTaskToHealthyMs",
  "bindMs",
  "bindLoadMs",
  "firstInvokeMs",
  "runTaskToFirstInvokeMs"
])
  console.log(row(k, pct(runs.map((r) => r[k]))));
