// PROTOTYPE for #311 round 2: Neon idle autosuspend, alone. Hold one idle
// connection (no transaction) past the 5-minute autosuspend and read the
// endpoint's current_state from the Neon API each minute for 8 minutes; then
// the same with the connection inside an open transaction.
import pg from "pg";
const env = (k) =>
  process.env[k] ??
  (() => {
    throw new Error(`${k} missing`);
  })();
const api = async () =>
  (
    await (
      await fetch(
        `https://console.neon.tech/api/v2/projects/${env("NEON_PROJECT_ID")}/endpoints/${env("NEON_ENDPOINT_ID")}`,
        { headers: { authorization: `Bearer ${env("NEON_API_KEY")}` } }
      )
    ).json()
  ).endpoint;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function phase(label, setup) {
  const c = new pg.Client({
    connectionString: env("DATABASE_URL"),
    application_name: "autosuspend-probe"
  });
  let dropped;
  c.on("error", (e) => {
    dropped = { at: new Date().toISOString().slice(11, 19), error: `${e.code} ${e.message}` };
    log(label, "connection dropped:", e.code, e.message);
  });
  const t0 = Date.now();
  await c.connect();
  log(label, "connected in", Date.now() - t0, "ms; state", (await api()).current_state);
  await setup(c);
  const samples = [];
  for (let m = 1; m <= 8; m++) {
    await sleep(60_000);
    const e = await api();
    samples.push({ minute: m, state: e.current_state, dropped: dropped ?? null });
    log(label, `minute ${m}: current_state=${e.current_state}`);
  }
  let after;
  try {
    const t1 = Date.now();
    const r = await c.query("select now()");
    after = `query on the held connection succeeded in ${Date.now() - t1} ms`;
  } catch (e) {
    after = `query on the held connection failed: ${e.message}`;
  }
  log(label, after);
  try {
    await c.query("COMMIT");
  } catch {}
  await c.end().catch(() => {});
  return { label, samples, dropped, after };
}
const out = {};
const phases = (process.env.PHASES ?? "idle,tx").split(",");
log("endpoint state before:", (await api()).current_state);
if (phases.includes("idle"))
  out.idle = await phase("idle connection, no transaction", async () => {});
// Let the compute come back and settle before the second phase.
if (phases.includes("tx"))
  out.inTransaction = await phase("idle in transaction", async (c) => {
    await c.query("BEGIN");
    await c.query("select 1");
  });
console.log(JSON.stringify(out, null, 1));
