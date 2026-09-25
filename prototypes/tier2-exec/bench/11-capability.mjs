// PROTOTYPE for #311: measurement 11, replaying a callback token after the
// invocation ended.
import { invoke, H, save } from "./lib.mjs";
const r = await invoke({ company: "acme", handler: "contacts.list" });
const cap = r.debug.capability;
const replay = async (token) => {
  const res = await fetch(`${H}/callback`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ op: "tables.list", args: { table: "contacts" } })
  });
  return { status: res.status, body: await res.json() };
};
const out = {
  invocation: r.outcome,
  replayAfterEnd: await replay(cap),
  unknownToken: await replay("not-a-token")
};
console.log(JSON.stringify(out));
save("11-capability", out);
