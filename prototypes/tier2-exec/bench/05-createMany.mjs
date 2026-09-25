// PROTOTYPE for #311: measurement 5, the ten-callback mutation end to end
// including commit, n=60, plus one run's breakdown and three-way attribution.
import { invoke, admin, pct, header, row, save } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
const runs = [];
for (let i = 0; i < 60; i++)
  runs.push(
    await invoke({ company: "acme", handler: "contacts.createMany", args: { prefix: `m${i}` } })
  );
const t = runs.map((r) => ({
  ...r.timing,
  wallMs: r.wallMs,
  outcome: r.outcome,
  attempts: r.attempts
}));
console.log(header("contacts.createMany, 10 callbacks (ms)"));
for (const k of ["beginRowMs", "execMs", "callbackMs", "sqlMs", "commitMs", "totalMs", "wallMs"])
  console.log(row(k, pct(t.map((r) => r[k] ?? 0))));
console.log(
  "outcomes",
  t.reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] ?? 0) + 1 }), {}),
  "attempts>1:",
  t.filter((r) => r.attempts > 1).length
);
const one = runs[30];
console.log(
  "one run breakdown:",
  JSON.stringify({
    total: one.timing.totalMs,
    beginRow: one.timing.beginRowMs,
    execHop: one.timing.execMs,
    guest: one.timing.guestMs,
    callbacks: one.timing.callbacks,
    callbackSum: one.timing.callbackMs,
    sqlSum: one.timing.sqlMs,
    commit: one.timing.commitMs
  })
);
// Attribution three ways + the query as the viewer.
const attr = [];
for (const as of ["viewer", "patch", "viewer-via-patch"])
  attr.push(
    await invoke({
      company: "acme",
      handler: "contacts.createMany",
      args: { prefix: `attr-${as}` },
      as
    })
  );
attr.push(await invoke({ company: "acme", handler: "contacts.list" }));
const rows = await admin("/admin/rows?company=acme");
console.log("attribution:", JSON.stringify(rows.invocations.slice(0, 4)));
console.log("operations:", JSON.stringify(rows.operations.slice(0, 3)));
save("05-createMany", { runs: t, one: one.timing, attribution: rows });
