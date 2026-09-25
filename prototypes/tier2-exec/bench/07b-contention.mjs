// PROTOTYPE for #311: measurement 7 again with overlap forced: pairs of
// concurrent bumpSlow (30 ms host-side pause between read and write).
import { invoke, admin, pct, save } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
const all = [];
for (let i = 0; i < 20; i++)
  all.push(
    ...(await Promise.all([
      invoke(
        { company: "acme", handler: "contacts.bumpSlow", args: { name: "hits", ms: 30 } },
        { "x-viewer": "writer-a" }
      ),
      invoke(
        { company: "acme", handler: "contacts.bumpSlow", args: { name: "hits", ms: 30 } },
        { "x-viewer": "writer-b" }
      )
    ]))
  );
const counter = (await admin("/admin/rows?company=acme")).counters.find(
  (c) => c.name === "hits"
).value;
const retried = all.filter((r) => r.attempts > 1);
const out = {
  pairs: 20,
  committed: all.filter((r) => r.outcome === "committed").length,
  failed: all
    .filter((r) => r.outcome !== "committed")
    .map((r) => ({ outcome: r.outcome, error: r.error, attempts: r.attempts })),
  attemptsHistogram: all.reduce((m, r) => ({ ...m, [r.attempts]: (m[r.attempts] ?? 0) + 1 }), {}),
  where40001: retried.slice(0, 8).map((r) =>
    Object.entries(r.timing)
      .filter(([k]) => k.startsWith("attempt"))
      .map(([k, v]) => `${k}=${v}`)
      .join(",")
  ),
  finalCounter: counter,
  expected: all.filter((r) => r.outcome === "committed").length,
  totalMs: pct(all.map((r) => r.timing.totalMs)),
  retriedTotalMs: retried.length ? pct(retried.map((r) => r.timing.totalMs)) : null,
  firstTryTotalMs: pct(all.filter((r) => r.attempts === 1).map((r) => r.timing.totalMs))
};
console.log(JSON.stringify(out, null, 1));
save("07b-contention", out);
