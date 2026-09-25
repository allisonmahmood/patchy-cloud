// PROTOTYPE for #311: measurement 7, two writers on one counter row until a
// confirmed 40001, retried to a correct total; then the four-slot cap.
import { invoke, admin, pct, header, row, save, sleep } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
const N = 25;
const writer = async (w) => {
  const rs = [];
  for (let i = 0; i < N; i++)
    rs.push(
      await invoke(
        { company: "acme", handler: "contacts.bump", args: { name: "hits" } },
        { "x-viewer": w }
      )
    );
  return rs;
};
const [a, b] = await Promise.all([writer("writer-a"), writer("writer-b")]);
const all = [...a, ...b];
const counter = (await admin("/admin/rows?company=acme")).counters.find(
  (c) => c.name === "hits"
).value;
const retried = all.filter((r) => r.attempts > 1);
const out = {
  writers: 2,
  perWriter: N,
  committed: all.filter((r) => r.outcome === "committed").length,
  failed: all
    .filter((r) => r.outcome !== "committed")
    .map((r) => ({ outcome: r.outcome, error: r.error })),
  attemptsHistogram: all.reduce((m, r) => ({ ...m, [r.attempts]: (m[r.attempts] ?? 0) + 1 }), {}),
  where40001: retried
    .map((r) =>
      Object.entries(r.timing)
        .filter(([k]) => k.startsWith("attempt"))
        .map(([k, v]) => `${k}=${v}`)
        .join(",")
    )
    .slice(0, 10),
  finalCounter: counter,
  expected: all.filter((r) => r.outcome === "committed").length,
  totalMs: pct(all.map((r) => r.timing.totalMs)),
  retriedTotalMs: retried.length ? pct(retried.map((r) => r.timing.totalMs)) : null
};
console.log(JSON.stringify(out, null, 1));
// Four-slot cap: five concurrent slow queries, the fifth is refused fast.
const five = await Promise.all(
  [0, 1, 2, 3, 4].map((i) =>
    sleep(i * 30).then(() =>
      invoke({ company: "acme", handler: "contacts.slow", args: { ms: 2000 } })
    )
  )
);
out.slots = five.map((r) => ({
  outcome: r.outcome ?? r.error,
  slots: r.timing?.slotsInUse ?? r.slots,
  wallMs: r.wallMs
}));
console.log("slots:", JSON.stringify(out.slots));
save("07-contention", out);
