// PROTOTYPE for #311 round 2: item 2, deadline cleanup mid-callback and
// mid-commit. For each: capability revoked, late callback refused by name,
// slot released, no transaction left in pg_stat_activity, and the caller's
// error distinguishes a known rollback from unknown_outcome.
import { invoke, admin, H, save, sleep } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
const replay = async (cap) => {
  const r = await fetch(`${H}/callback`, {
    method: "POST",
    headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" },
    body: JSON.stringify({
      op: "tables.insert",
      args: { table: "contacts", row: { name: "late", email: "l@example.com" } }
    })
  });
  return { status: r.status, ...(await r.json()) };
};
const after = async (r, label) => {
  const activity = await admin("/admin/pg-activity");
  const next = await invoke({ company: "acme", handler: "contacts.ping" });
  const inv = await admin(`/admin/invocation?id=${r.id}`);
  return {
    label,
    outcome: r.outcome,
    rollback: r.rollback,
    error: r.error,
    totalMs: r.timing?.totalMs,
    callbacksDone: r.timing?.callbacks?.length,
    lateCallbackReplay: await replay(r.debug.capability),
    guestSawOnLateCallbacks: inv.refusals,
    openTransactionsAfter: activity.openTransactions,
    slotsAfter: activity.slotsInUse.acme,
    nextInvokeOutcome: next.outcome
  };
};
const out = {};
// (a) deadline during a slow SQL callback: insert, pg_sleep(8 s), insert.
out.midCallback = await after(
  await invoke({
    company: "acme",
    handler: "contacts.slowWrite",
    args: { prefix: "dl-a", ms: 8000 }
  }),
  "mid-callback (pg_sleep 8 s)"
);
out.midCallback.rowsLanded = (await admin("/admin/rows?company=acme&like=dl-a-%")).named;
console.log(JSON.stringify(out.midCallback, null, 1));
// (a2) the handler catches the failed callback and tries to write again.
out.midCallbackRetry = await after(
  await invoke({
    company: "acme",
    handler: "contacts.slowWriteThenRetry",
    args: { prefix: "dl-b", ms: 8000 }
  }),
  "mid-callback, handler retries after the failure"
);
out.midCallbackRetry.rowsLanded = (await admin("/admin/rows?company=acme&like=dl-b-%")).named;
console.log(JSON.stringify(out.midCallbackRetry, null, 1));
// (b) deadline during COMMIT: the host waits past the deadline before sending COMMIT.
out.midCommitDelay = await after(
  await invoke({
    company: "acme",
    handler: "contacts.createMany",
    args: { prefix: "dl-c" },
    inject: "commit-delay:5200"
  }),
  "commit delayed past the deadline"
);
out.midCommitDelay.rowsLanded = (await admin("/admin/rows?company=acme&like=dl-c-%")).named.length;
console.log(JSON.stringify(out.midCommitDelay, null, 1));
// (b2) lost commit reply: COMMIT sent, socket destroyed 2 ms later, five runs.
out.lostCommitReply = [];
for (let i = 0; i < 5; i++) {
  const r = await invoke({
    company: "acme",
    handler: "contacts.createMany",
    args: { prefix: `dl-l${i}` },
    inject: "lost-commit-reply"
  });
  const a = await after(r, `lost commit reply #${i}`);
  a.rowsLanded = (await admin(`/admin/rows?company=acme&like=dl-l${i}-%`)).named.length;
  out.lostCommitReply.push(a);
  console.log(
    JSON.stringify({
      outcome: a.outcome,
      rollback: a.rollback,
      rowsLanded: a.rowsLanded,
      error: a.error,
      replay: a.lateCallbackReplay.reason,
      openTx: a.openTransactionsAfter,
      next: a.nextInvokeOutcome
    })
  );
}
save("r2-02-deadline", out);
