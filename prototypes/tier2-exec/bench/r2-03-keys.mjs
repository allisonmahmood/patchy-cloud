// PROTOTYPE for #311 round 2: item 3, per-call mutation keys: concurrent
// same-key submissions, replay after a lost commit reply, replay after the
// host was replaced (this script runs the first two; r2-04 covers the third).
import { invoke, admin, save } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
const out = {};
// (a) two concurrent submissions with one key.
const k1 = `k-${Date.now()}`;
const [a, b] = await Promise.all([
  invoke({ company: "acme", handler: "contacts.createMany", args: { prefix: "key-a" }, key: k1 }),
  invoke({ company: "acme", handler: "contacts.createMany", args: { prefix: "key-a" }, key: k1 })
]);
const rowsA = (await admin("/admin/rows?company=acme&like=key-a-%")).named.length;
out.concurrent = {
  first: { outcome: a.outcome, deduplicated: a.deduplicated ?? null, result: a.result, id: a.id },
  second: { outcome: b.outcome, deduplicated: b.deduplicated ?? null, result: b.result, id: b.id },
  rowsInserted: rowsA,
  sameResult: JSON.stringify(a.result) === JSON.stringify(b.result),
  sameId: a.id === b.id
};
console.log(JSON.stringify(out.concurrent));
// (a2) a third submission later, from the table.
const c = await invoke({
  company: "acme",
  handler: "contacts.createMany",
  args: { prefix: "key-a" },
  key: k1
});
out.later = {
  outcome: c.outcome,
  deduplicated: c.deduplicated,
  result: c.result,
  totalMs: c.timing.totalMs,
  rows: (await admin("/admin/rows?company=acme&like=key-a-%")).named.length
};
console.log(JSON.stringify(out.later));
// (b) lost commit reply, then replay with the same key.
out.lost = [];
for (let i = 0; i < 5; i++) {
  const k = `k-lost-${Date.now()}-${i}`;
  const r = await invoke({
    company: "acme",
    handler: "contacts.createMany",
    args: { prefix: `key-l${i}` },
    key: k,
    inject: "lost-commit-reply"
  });
  const rows1 = (await admin(`/admin/rows?company=acme&like=key-l${i}-%`)).named.length;
  const p = await invoke({
    company: "acme",
    handler: "contacts.createMany",
    args: { prefix: `key-l${i}` },
    key: k
  });
  const rows2 = (await admin(`/admin/rows?company=acme&like=key-l${i}-%`)).named.length;
  out.lost.push({
    first: r.outcome,
    rowsAfterFirst: rows1,
    replay: p.outcome,
    replayDeduplicated: p.deduplicated ?? null,
    replayResult: p.result,
    rowsAfterReplay: rows2,
    reExecuted: rows2 > rows1
  });
  console.log(JSON.stringify(out.lost[i]));
}
// Leave a committed key behind for r2-04's host-replacement replay.
const kHost = "k-host-replacement";
await admin("/admin/reset?company=acme", "POST");
const h = await invoke({
  company: "acme",
  handler: "contacts.createMany",
  args: { prefix: "key-host" },
  key: kHost
});
out.forHostReplacement = { key: kHost, outcome: h.outcome, id: h.id, result: h.result };
console.log(JSON.stringify(out.forHostReplacement));
save("r2-03-keys", out);
