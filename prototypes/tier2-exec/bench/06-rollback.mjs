// PROTOTYPE for #311: measurement 6, createThenFail rolls back.
import { invoke, admin, save } from "./lib.mjs";
await admin("/admin/reset?company=acme", "POST");
await invoke({ company: "acme", handler: "contacts.createMany", args: { prefix: "base" } });
const before = (await admin("/admin/rows?company=acme")).contacts;
const r = await invoke({
  company: "acme",
  handler: "contacts.createThenFail",
  args: { prefix: "x" }
});
const rows = await admin("/admin/rows?company=acme");
const out = {
  rowsBefore: before,
  rowsAfter: rows.contacts,
  outcome: r.outcome,
  error: r.error,
  callbacksBeforeThrow: r.timing.callbacks.length,
  operationRowsForInvocation: rows.invocations.find((i) => i.handler === "contacts.createThenFail")
    ?.ops,
  totalMs: r.timing.totalMs
};
console.log(JSON.stringify(out));
save("06-rollback", out);
