// PROTOTYPE for #311 round 2: item 5, the authorisation boundary, one table
// row per attempt: expected vs observed.
import { invoke, admin, H, save, sleep } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
await invoke({ company: "beta", handler: "contacts.ping" });
const cb = async (cap, body, headers = {}) => {
  const r = await fetch(`${H}/callback`, {
    method: "POST",
    headers: { authorization: `Bearer ${cap}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  return `${r.status} ${j.error ?? "ok"}${j.reason ? ` (${j.reason})` : ""}`;
};
const rows = [];
const row = (attempt, expected, observed) => {
  rows.push({ attempt, expected, observed, held: observed.startsWith(expected.split(" ")[0]) });
  console.log(`| ${attempt} | ${expected} | ${observed} |`);
};
// A live capability: a 4 s query on acme/crm, and a 4 s mutation.
const liveQ = invoke({
  company: "acme",
  patch: "crm",
  handler: "contacts.slow",
  args: { ms: 4000 }
});
const liveM = invoke({
  company: "acme",
  patch: "crm",
  handler: "contacts.slowWrite",
  args: { prefix: "authz", ms: 3000 }
});
await sleep(1200);
const live = await admin("/admin/live");
const q = live.find((i) => i.kind === "query"),
  m = live.find((i) => i.kind === "mutation");
row(
  "callback naming company beta with acme/crm's capability",
  "403 scope_mismatch",
  await cb(m.capability, { op: "tables.list", args: { table: "contacts" }, company: "beta" })
);
row(
  "callback naming patch other with acme/crm's capability",
  "403 scope_mismatch",
  await cb(m.capability, { op: "tables.list", args: { table: "contacts" }, patch: "other" })
);
row(
  "tables.insert on a query-kind invocation",
  "403 query_cannot_write",
  await cb(q.capability, {
    op: "tables.insert",
    args: { table: "contacts", row: { name: "esc", email: "e@x" } }
  })
);
row(
  "next callback on that query after the escalation attempt",
  "409 attempt_aborted",
  await cb(q.capability, { op: "tables.list", args: { table: "contacts" } })
);
row(
  "callback with a forged older process generation",
  "403 stale_generation",
  await cb(
    m.capability,
    { op: "tables.list", args: { table: "contacts" } },
    { "x-exec-generation": String((m.execGeneration ?? 1) - 1) }
  )
);
const [rq, rm] = await Promise.all([liveQ, liveM]);
row(
  "callback after the invocation ended",
  "403 capability_refused (invocation_ended)",
  await cb(m.capability, { op: "tables.list", args: { table: "contacts" } })
);
// Attempt 1's capability after a 40001 re-invocation started attempt 2.
await admin("/admin/reset?company=acme", "POST");
const pair = await Promise.all([
  invoke({ company: "acme", handler: "contacts.bumpSlow", args: { name: "hits", ms: 300 } }),
  invoke({ company: "acme", handler: "contacts.bumpSlow", args: { name: "hits", ms: 300 } })
]);
const retried = pair.find((r) => r.attempts > 1);
if (retried) {
  row(
    "attempt 1 callback token after the 40001 re-invocation (attempts=" + retried.attempts + ")",
    "403 capability_refused (attempt_superseded)",
    await cb(retried.debug.attemptCapabilities[0], {
      op: "tables.list",
      args: { table: "counters" }
    })
  );
} else
  row(
    "attempt 1 token after 40001",
    "403 capability_refused (attempt_superseded)",
    "no 40001 occurred in this pair; see r2-05 rerun"
  );
// Previous process generation: kill via abuse.loop, then replay that invocation's token.
const loop = await invoke({ company: "acme", handler: "abuse.loop" });
row(
  `callback token of an invocation whose process was killed (${loop.outcome})`,
  "403 capability_refused",
  await cb(loop.debug.capability, { op: "tables.list", args: { table: "contacts" } })
);
// Guest reaching the supervisor.
const sup = await invoke({ company: "acme", handler: "probe.supervisor" });
for (const p of sup.result ?? [])
  row(
    `guest fetch ${p.url}`,
    "403 refused by loopback",
    p.status ? `${p.status} ${p.body?.slice(0, 40)}` : `error ${p.error}`
  );
// Host to supervisor without the shared secret, and with it.
const noSecret = await admin("/admin/raw-exec?company=acme&path=/stats&secret=0");
row(
  "management call to the supervisor without the shared secret",
  "401 unauthorized",
  `${noSecret.status} ${noSecret.body.error ?? "ok"}`
);
const withSecret = await admin("/admin/raw-exec?company=acme&path=/stats&secret=1");
row(
  "management call with the shared secret",
  "200 ok",
  `${withSecret.status} ${withSecret.body.error ?? "ok"}`
);
const stale = await admin("/admin/raw-exec?company=acme&path=/epoch&secret=1");
save("r2-05-authz", { rows, stale });
