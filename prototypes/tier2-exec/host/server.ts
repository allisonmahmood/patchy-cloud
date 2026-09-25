// PROTOTYPE for #311: stub of Patchy's runtime host as one Node process.
// /invoke picks the company's bound exec task and calls it; /callback runs
// table operations with a per-invocation capability, one SERIALIZABLE
// transaction per mutation opened on the first callback; /stream is SSE.
//
// Round 2: deadline cleanup (cancel the backend, roll back, revoke, release
// the slot, name the outcome), per-call mutation keys written inside the
// transaction, fault injection at commit, an owner epoch the pool carries to
// every exec task, and scope checks on callbacks.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { pool as db, migrate, reset, tableOp, warm } from "./db.ts";
import * as pool from "./pool.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const DEADLINE_MS = 5000;
// The exec watchdog is the backstop for CPU loops; idle waits expire on the
// host deadline first, so the watchdog sits one second behind it.
const WATCHDOG_MS = 6000;
let SLOTS = Number(process.env.SLOTS ?? 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bundles and manifest produced by handlers/build.mjs, copied in by infra/build.sh.
const bundlesDir = join(here, "bundles");
const manifest: Record<string, "query" | "mutation"> = JSON.parse(
  readFileSync(join(bundlesDir, "manifest.json"), "utf8")
);
const bundles = Object.fromEntries(
  readdirSync(bundlesDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => [f.replace(/\.js$/, ""), readFileSync(join(bundlesDir, f), "utf8")])
);

// The host's own address as exec tasks reach it (private VPC IP on Fargate).
let hostUrl = process.env.HOST_URL ?? `http://127.0.0.1:${PORT}`;
async function discoverHostUrl() {
  const meta = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!meta) return;
  const t = await (await fetch(`${meta}/task`)).json();
  const ip = t.Containers?.[0]?.Networks?.[0]?.IPv4Addresses?.[0];
  if (ip) hostUrl = `http://${ip}:${PORT}`;
}

type Invocation = {
  id: string;
  attempt: number;
  capability: string;
  company: string;
  patch: string;
  kind: "query" | "mutation";
  principal: string;
  deadlineAt: number;
  client?: pg.PoolClient;
  txOpenedAt?: number;
  failed?: string;
  expired?: boolean;
  serializationFailure?: boolean;
  execGeneration?: number;
  ended: boolean;
  callbacks: Array<{ op: string; ms: number; sqlMs: number; at: number }>;
  refusals: Array<{ at: number; op?: string; error: string; reason?: string }>;
  rollback?: string;
};
const byCapability = new Map<string, Invocation>();
const endedCapabilities = new Map<string, string>(); // capability -> why refused
const endedInvocations = new Map<string, Invocation>(); // bounded, for /admin/invocation
const inFlight = new Map<string, number>(); // company -> slots in use
const inflightKeys = new Map<string, Promise<any>>(); // company/key -> the first submission's reply
let inFlightInvocations = 0;
let shuttingDown = false;

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}
function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, {
    "content-type": "application/json",
    "x-host-epoch": String(pool.epoch),
    ...headers
  });
  res.end(JSON.stringify(body));
}
function endCapability(inv: Invocation, why: string) {
  inv.ended = true;
  byCapability.delete(inv.capability);
  endedCapabilities.set(inv.capability, why);
  endedInvocations.set(inv.id, inv);
  if (endedInvocations.size > 500) endedInvocations.delete(endedInvocations.keys().next().value!);
}

// Roll back and release; says whether the rollback is confirmed.
async function rollback(inv: Invocation, cancelBackend = false) {
  const c = inv.client;
  if (!c) return (inv.rollback ??= "nothing_to_roll_back");
  inv.client = undefined;
  try {
    if (cancelBackend) await db.query("select pg_cancel_backend($1)", [(c as any).processID]);
    await c.query("ROLLBACK");
    inv.rollback = "confirmed";
    c.release();
  } catch (e: any) {
    inv.rollback = `unknown (${e.message})`;
    c.release(true);
  }
  return inv.rollback;
}

// ---- /callback: the capability broker's far end -------------------------
async function callback(req: IncomingMessage, res: ServerResponse) {
  const t0 = Date.now();
  const cap = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const inv = byCapability.get(cap);
  const body = JSON.parse((await readBody(req)) || "{}");
  const { op, args } = body;
  const refuse = (status: number, error: string, reason?: string, target?: Invocation) => {
    target?.refusals.push({ at: Date.now(), op, error, reason });
    return send(res, status, { error, reason });
  };
  if (!inv) {
    const reason = endedCapabilities.get(cap) ?? "unknown_capability";
    const ended = [...endedInvocations.values()].find((i) => i.capability === cap);
    return refuse(403, "capability_refused", reason, ended);
  }
  // Scope: a callback may name its company/patch; a mismatch is refused.
  if ((body.company && body.company !== inv.company) || (body.patch && body.patch !== inv.patch))
    return refuse(403, "scope_mismatch", `capability is for ${inv.company}/${inv.patch}`, inv);
  // Process generation: callbacks must come from the generation that started the attempt.
  const gen =
    req.headers["x-exec-generation"] !== undefined
      ? Number(req.headers["x-exec-generation"])
      : undefined;
  if (gen !== undefined) {
    if (inv.execGeneration === undefined) inv.execGeneration = gen;
    else if (inv.execGeneration !== gen)
      return refuse(
        403,
        "stale_generation",
        `attempt started on generation ${inv.execGeneration}, callback from ${gen}`,
        inv
      );
  }
  if (inv.failed) return refuse(409, "attempt_aborted", inv.failed, inv);
  if (op === "util.sleep") {
    await sleep(Math.min(args.ms, 10_000));
    inv.callbacks.push({ op, ms: Date.now() - t0, sqlMs: 0, at: t0 });
    return send(res, 200, { result: null });
  }
  if (inv.kind === "query" && op !== "tables.list") {
    inv.failed = "query_cannot_write";
    return refuse(403, "query_cannot_write", `${op} in a query-kind invocation`, inv);
  }
  try {
    let q: { query: pg.Pool["query"] } = db;
    if (inv.kind === "mutation") {
      if (!inv.client) {
        inv.client = await db.connect();
        inv.txOpenedAt = Date.now();
        await inv.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await inv.client.query(
          `SET LOCAL statement_timeout = ${Math.max(100, inv.deadlineAt - Date.now())}`
        );
      }
      q = inv.client;
    }
    const s0 = Date.now();
    let result: unknown;
    if (op === "util.slowSql")
      result = (await q.query("select pg_sleep($1::float / 1000)", [args.ms])).rowCount;
    else {
      result = await tableOp(q, inv.company, inv.principal, op, args);
      await q.query(
        "insert into operations (invocation_id, attempt, op, principal, ms) values ($1, $2, $3, $4, $5)",
        [inv.id, inv.attempt, op, inv.principal, Date.now() - s0]
      );
    }
    const sqlMs = Date.now() - s0;
    inv.callbacks.push({ op, ms: Date.now() - t0, sqlMs, at: t0 });
    if (inv.expired)
      return refuse(409, "attempt_expired", "deadline passed while the statement ran", inv);
    send(res, 200, { result, ms: Date.now() - t0, sqlMs });
  } catch (e: any) {
    inv.failed =
      e.code === "40001"
        ? "serialization_failure"
        : e.code === "57014"
          ? "statement_timeout"
          : `sql_error:${e.code ?? e.message}`;
    if (e.code === "40001") inv.serializationFailure = true;
    inv.callbacks.push({ op: `${op}!${inv.failed}`, ms: Date.now() - t0, sqlMs: 0, at: t0 });
    inv.refusals.push({ at: Date.now(), op, error: inv.failed, reason: e.message });
    send(res, 409, { error: inv.failed, detail: e.message });
  }
}

// ---- /invoke ------------------------------------------------------------
async function invoke(req: IncomingMessage, res: ServerResponse) {
  const t0 = Date.now();
  const body = JSON.parse(await readBody(req));
  const {
    company,
    patch = "crm",
    version = "v1",
    handler,
    args = {},
    as = "viewer",
    limits,
    key,
    inject
  } = body;
  const viewer = String(req.headers["x-viewer"] ?? "anonymous");
  const kind = manifest[handler];
  if (!kind || !bundles[version])
    return send(res, 404, { error: "no_such_handler", handler, version });
  if (shuttingDown) return send(res, 503, { error: "host_shutting_down" });
  const principal =
    as === "viewer"
      ? `user:${viewer}`
      : as === "patch"
        ? `patch:${patch}`
        : `user:${viewer} via patch:${patch}`;

  // Mutation keys: a committed key answers from the table; a concurrent
  // submission of the same key waits for the first and gets its reply.
  const keyId = key ? `${company}/${key}` : undefined;
  if (keyId) {
    const row = (
      await db.query(
        "select invocation_id, result from mutation_keys where company = $1 and key = $2",
        [company, key]
      )
    ).rows[0];
    if (row)
      return send(res, 200, {
        ok: true,
        outcome: "committed",
        deduplicated: "from_table",
        id: row.invocation_id,
        result: row.result,
        timing: { totalMs: Date.now() - t0 }
      });
    const running = inflightKeys.get(keyId);
    if (running) {
      const first = await running;
      return send(res, first.status, { ...first.body, deduplicated: "concurrent" });
    }
  }
  const reply = new Promise<{ status: number; body: any }>((resolveReply) => {
    invokeInner({
      t0,
      company,
      patch,
      version,
      handler,
      args,
      as,
      limits,
      key,
      inject,
      viewer,
      kind,
      principal
    }).then(resolveReply);
  });
  if (keyId) inflightKeys.set(keyId, reply);
  const out = await reply;
  if (keyId) inflightKeys.delete(keyId);
  send(res, out.status, out.body);
}

async function invokeInner(p: {
  t0: number;
  company: string;
  patch: string;
  version: string;
  handler: string;
  args: any;
  as: string;
  limits: any;
  key?: string;
  inject?: string;
  viewer: string;
  kind: "query" | "mutation";
  principal: string;
}) {
  const {
    t0,
    company,
    patch,
    version,
    handler,
    args,
    as,
    limits,
    key,
    inject,
    viewer,
    kind,
    principal
  } = p;
  const slots = inFlight.get(company) ?? 0;
  if (slots >= SLOTS) return { status: 429, body: { error: "busy", outcome: "busy", slots } };
  inFlight.set(company, slots + 1);
  inFlightInvocations++;
  const id = randomUUID();
  const name = `${company}/${patch}@${version}`;
  const timing: any = { slotsInUse: slots + 1 };
  const deadlineAt = t0 + DEADLINE_MS;
  let outcome = "unknown";
  let attempts = 0;
  let result: any;
  let error: string | undefined;
  let lastCapability = "";
  const attemptCapabilities: string[] = [];
  let execOut: any;
  let rollbackState: string | undefined;
  let deduplicated: string | undefined;
  try {
    // Bind (the wake path). The mutation transaction never opens while binding.
    const task = await pool.acquire(company, async (t) => {
      const r = await fetch(`${t.url}/bind`, {
        method: "POST",
        headers: pool.execHeaders(),
        body: JSON.stringify({ name, bundle: bundles[version] })
      });
      const out = await r.json();
      if (!out.ok) throw new Error(`bind failed: ${out.error}`);
      t.loaded.add(name);
      timing.bindLoadMs = out.loadMs;
      timing.spawnMs = out.spawnMs;
    });
    timing.bindMs = task.times.bindMs;
    timing.boundAfterMs = Date.now() - t0;
    const b0 = Date.now();
    await db.query(
      "insert into invocations (id, company, patch, version, handler, kind, viewer, as_mode, principal, started_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
      [id, company, patch, version, handler, kind, viewer, as, principal]
    );
    timing.beginRowMs = Date.now() - b0;

    for (attempts = 1; attempts <= 3; attempts++) {
      const inv: Invocation = {
        id,
        attempt: attempts,
        capability: randomUUID(),
        company,
        patch,
        kind,
        principal,
        deadlineAt,
        ended: false,
        callbacks: [],
        refusals: []
      };
      lastCapability = inv.capability;
      attemptCapabilities.push(inv.capability);
      byCapability.set(inv.capability, inv);
      const e0 = Date.now();
      const abort = new AbortController();
      // The deadline: expire the attempt, cancel its backend, roll back, revoke.
      const expired = new Promise<void>((resolve) => {
        const timer = setTimeout(
          async () => {
            if (inv.ended) return resolve();
            inv.expired = true;
            inv.failed ??= "deadline";
            endCapability(inv, "invocation_expired");
            abort.abort();
            await rollback(inv, true);
            resolve();
          },
          Math.max(0, deadlineAt - Date.now())
        );
        (inv as any).timer = timer;
      });
      let r: Response;
      try {
        const call = async (withBundle: boolean) =>
          fetch(`${task.url}/invoke`, {
            method: "POST",
            headers: pool.execHeaders(),
            body: JSON.stringify({
              name,
              bundle: withBundle ? bundles[version] : undefined,
              invocationId: id,
              capability: inv.capability,
              hostUrl,
              handler,
              args,
              viewer,
              budgetMs: WATCHDOG_MS,
              limits
            }),
            signal: abort.signal
          });
        r = await call(!task.loaded.has(name));
        if (r.status === 409) r = await call(true); // workerd restarted or reaped and forgot the bundle
      } catch (e: any) {
        clearTimeout((inv as any).timer);
        await expired;
        outcome = "handler_timeout";
        error = `deadline ${DEADLINE_MS} ms passed while the handler ran (${inv.callbacks.length} callbacks done)`;
        rollbackState = inv.rollback ?? "nothing_to_roll_back";
        timing.execMs = Date.now() - e0;
        timing.callbacks = inv.callbacks.map((c) => ({ op: c.op, ms: c.ms, sqlMs: c.sqlMs }));
        break;
      }
      clearTimeout((inv as any).timer);
      execOut = await r.json();
      if (r.status === 412) {
        endCapability(inv, "invocation_ended");
        await rollback(inv);
        outcome = "stale_owner";
        error = `exec refused epoch ${pool.epoch}: highest seen ${execOut.highestEpoch}`;
        break;
      }
      if (r.status === 401) {
        endCapability(inv, "invocation_ended");
        outcome = "exec_unauthorized";
        error = "exec refused the shared secret";
        break;
      }
      if (execOut.generation !== undefined && execOut.generation !== task.generation) {
        task.generation = execOut.generation;
        task.loaded.clear();
      }
      task.loaded.add(name);
      task.lastUsed = Date.now();
      if (!task.times.firstInvoke) task.times.firstInvoke = Date.now();
      timing.execMs = Date.now() - e0;
      timing.execReportedMs = execOut.execMs;
      timing.guestMs = execOut.guestMs;
      timing.firstLoad = execOut.firstLoad;
      timing.spawnMs = execOut.spawnMs;
      timing.mode = execOut.mode;
      timing.callbacks = inv.callbacks.map((c) => ({ op: c.op, ms: c.ms, sqlMs: c.sqlMs }));
      timing.callbackMs = inv.callbacks.reduce((a, c) => a + c.ms, 0);
      timing.sqlMs = inv.callbacks.reduce((a, c) => a + c.sqlMs, 0);

      if (inv.serializationFailure) {
        endCapability(inv, "attempt_superseded");
        await rollback(inv);
        timing[`attempt${attempts}`] = "40001";
        if (Date.now() < deadlineAt - 200 && attempts < 3) continue;
        outcome = "serialization_failure";
        error = "serialization failure after retries";
        break;
      }
      if (execOut.ok && !inv.failed) {
        if (inv.client) {
          // Commit, with the injection points the deadline and lost-reply
          // measurements need. A COMMIT that answers ROLLBACK is a rollback.
          if (inject?.startsWith("commit-delay:")) await sleep(Number(inject.split(":")[1]));
          if (Date.now() >= deadlineAt) {
            endCapability(inv, "invocation_expired");
            await rollback(inv);
            outcome = "handler_timeout";
            error = "deadline passed before COMMIT was sent";
            rollbackState = inv.rollback;
            break;
          }
          if (key)
            await inv.client.query(
              "insert into mutation_keys (company, key, invocation_id, result) values ($1, $2, $3, $4)",
              [company, key, id, JSON.stringify(execOut.result)]
            );
          const c0 = Date.now();
          const client = inv.client;
          inv.client = undefined;
          try {
            if (inject === "lost-commit-reply") {
              // Send COMMIT, then destroy the socket before the reply arrives.
              client.on("error", () => {}); // the destroyed socket reports on the client
              const commit = client.query("COMMIT");
              setTimeout(() => (client as any).connection.stream.destroy(), 2);
              await commit;
            } else {
              const cr = await client.query("COMMIT");
              if (cr.command !== "COMMIT")
                throw Object.assign(new Error(`commit answered ${cr.command}`), {
                  code: "commit_answered_rollback"
                });
            }
            client.release();
            timing.commitMs = Date.now() - c0;
          } catch (e: any) {
            timing.commitMs = Date.now() - c0;
            client.release(true);
            endCapability(inv, e.code === "40001" ? "attempt_superseded" : "invocation_ended");
            if (e.code === "40001" && attempts < 3 && Date.now() < deadlineAt - 200) {
              timing[`attempt${attempts}`] = "40001@commit";
              continue;
            }
            if (e.code === "40001") outcome = "serialization_failure";
            else if (e.code === "commit_answered_rollback") outcome = "rolled_back";
            else outcome = "unknown_outcome";
            error = e.message;
            rollbackState =
              outcome === "unknown_outcome" ? "unknown (COMMIT sent, reply lost)" : "confirmed";
            break;
          }
        }
        endCapability(inv, "invocation_ended");
        outcome = "committed";
        result = execOut.result;
        break;
      }
      endCapability(inv, "invocation_ended");
      await rollback(inv);
      rollbackState = inv.rollback;
      outcome = execOut.error?.startsWith("watchdog_killed")
        ? "watchdog_killed"
        : inv.failed
          ? `callback_failed:${inv.failed}`
          : "handler_failed";
      error = execOut.error ?? inv.failed;
      timing.kill = execOut.kill;
      if (outcome === "watchdog_killed" && inv.txOpenedAt) rollbackState = inv.rollback; // the kill happened before COMMIT; the rollback is ours
      break;
    }
  } catch (e: any) {
    outcome = "host_error";
    error = e.message;
  } finally {
    inFlight.set(company, (inFlight.get(company) ?? 1) - 1);
    inFlightInvocations--;
  }
  timing.totalMs = Date.now() - t0;
  db.query(
    "update invocations set attempts = $2, outcome = $3, ended_at = now(), timing = $4 where id = $1",
    [id, attempts, outcome, timing]
  ).catch(() => {});
  const status =
    outcome === "committed"
      ? 200
      : outcome === "handler_timeout"
        ? 504
        : outcome === "busy"
          ? 429
          : 500;
  return {
    status,
    body: {
      ok: outcome === "committed",
      id,
      outcome,
      rollback: rollbackState,
      attempts: Math.min(attempts, 3),
      result,
      error,
      principal,
      deduplicated,
      hostEpoch: pool.epoch,
      timing,
      debug: { capability: lastCapability, attemptCapabilities }
    }
  };
}

// ---- admin + stream -----------------------------------------------------
async function execFor(company: string) {
  const t = pool.tasks.find((t) => t.state === "bound" && t.company === company);
  if (!t) throw new Error(`no task bound for ${company}`);
  return t;
}
const execGet = async (t: pool.Task, path: string, withSecret = true) => {
  const h: Record<string, string> = pool.execHeaders();
  if (!withSecret) delete h["x-exec-secret"];
  const r = await fetch(`${t.url}${path}`, { headers: h });
  return { status: r.status, body: await r.json() };
};

async function admin(url: URL, req: IncomingMessage, res: ServerResponse) {
  const company = url.searchParams.get("company") ?? "acme";
  switch (url.pathname) {
    case "/admin/pool":
      return send(res, 200, pool.snapshot());
    case "/admin/release":
      await pool.release(company);
      return send(res, 200, { released: company });
    case "/admin/drain":
      return send(res, 200, { drained: (await pool.drainReady()).length });
    case "/admin/mode": // PROCESS_MODE for tasks started from now on
      pool.setProcessMode(url.searchParams.get("mode") ?? "company");
      return send(res, 200, { processMode: pool.processMode });
    case "/admin/reset":
      await reset(company);
      await db.query("delete from mutation_keys where company = $1", [company]);
      return send(res, 200, { reset: company });
    case "/admin/rows": {
      const contacts = await db.query(
        "select count(*)::int as n from contacts where company = $1",
        [company]
      );
      const named = url.searchParams.get("like")
        ? await db.query(
            "select name from contacts where company = $1 and name like $2 order by name",
            [company, url.searchParams.get("like")]
          )
        : { rows: [] };
      const counters = await db.query("select name, value from counters where company = $1", [
        company
      ]);
      const inv = await db.query(
        "select id, handler, as_mode, principal, attempts, outcome, (select count(*)::int from operations o where o.invocation_id = i.id) as ops from invocations i where company = $1 order by started_at desc limit 12",
        [company]
      );
      const ops = await db.query(
        "select o.op, o.principal, o.attempt from operations o join invocations i on i.id = o.invocation_id where i.company = $1 order by o.id desc limit 12",
        [company]
      );
      const keys = await db.query(
        "select key, invocation_id, result from mutation_keys where company = $1 order by committed_at desc limit 12",
        [company]
      );
      return send(res, 200, {
        contacts: contacts.rows[0].n,
        named: named.rows.map((r) => r.name),
        counters: counters.rows,
        invocations: inv.rows,
        operations: ops.rows,
        keys: keys.rows
      });
    }
    case "/admin/pg-activity": {
      const r = await db.query(
        "select pid, state, left(query, 40) as query, now() - xact_start as xact_age from pg_stat_activity where application_name = 'tier2-host' and (state = 'active' or state like 'idle in transaction%') and query not like '%pg_stat_activity%'"
      );
      return send(res, 200, {
        openTransactions: r.rows.length,
        rows: r.rows,
        slotsInUse: Object.fromEntries(inFlight)
      });
    }
    case "/admin/live": // capabilities of invocations in flight (for the boundary checks)
      return send(
        res,
        200,
        [...byCapability.values()].map((i) => ({
          id: i.id,
          capability: i.capability,
          company: i.company,
          patch: i.patch,
          kind: i.kind,
          attempt: i.attempt,
          execGeneration: i.execGeneration
        }))
      );
    case "/admin/invocation": {
      const i =
        endedInvocations.get(url.searchParams.get("id") ?? "") ??
        [...byCapability.values()].find((x) => x.id === url.searchParams.get("id"));
      return send(
        res,
        i ? 200 : 404,
        i
          ? {
              id: i.id,
              attempt: i.attempt,
              ended: i.ended,
              expired: i.expired,
              failed: i.failed,
              rollback: i.rollback,
              callbacks: i.callbacks,
              refusals: i.refusals,
              capabilityState: endedCapabilities.get(i.capability) ?? "live"
            }
          : { error: "not_found" }
      );
    }
    case "/admin/stats": {
      const t = await execFor(company);
      return send(res, 200, { task: t.id, ...(await execGet(t, "/stats")).body });
    }
    case "/admin/probe": {
      const t = await execFor(company);
      return send(res, 200, {
        task: t.id,
        supervisor: (await execGet(t, "/probe")).body,
        guestOutboundAttempts: (await execGet(t, "/outbound-attempts")).body
      });
    }
    case "/admin/raw-exec": {
      // Proxy a management call to the company's task with or without the secret.
      const t = await execFor(company);
      return send(
        res,
        200,
        await execGet(
          t,
          url.searchParams.get("path") ?? "/stats",
          url.searchParams.get("secret") !== "0"
        )
      );
    }
    case "/admin/coldstart": {
      const t = await pool.startTask({ track: false });
      const name = `${company}/crm@v1`;
      const b0 = Date.now();
      const bind = await (
        await fetch(`${t.url}/bind`, {
          method: "POST",
          headers: pool.execHeaders(),
          body: JSON.stringify({ name, bundle: bundles.v1 })
        })
      ).json();
      const bindMs = Date.now() - b0;
      const i0 = Date.now();
      await (
        await fetch(`${t.url}/invoke`, {
          method: "POST",
          headers: pool.execHeaders(),
          body: JSON.stringify({
            name,
            invocationId: "cold",
            capability: "none",
            hostUrl,
            handler: "contacts.ping",
            args: {},
            viewer: "bench",
            budgetMs: 5000
          })
        })
      ).json();
      const invokeMs = Date.now() - i0;
      await pool.stopTask(t, "coldstart measurement");
      return send(res, 200, {
        runTaskToRunningMs: t.times.running! - t.times.runTask,
        runTaskToHealthyMs: t.times.healthy! - t.times.runTask,
        bindMs,
        bindLoadMs: bind.loadMs,
        firstInvokeMs: invokeMs,
        runTaskToFirstInvokeMs: Date.now() - t.times.runTask
      });
    }
    case "/admin/sealed": {
      const t0 = Date.now();
      const { ECSClient, RunTaskCommand } = await import("@aws-sdk/client-ecs");
      const ecs = new ECSClient({ region: "us-east-1" });
      const r = await ecs.send(
        new RunTaskCommand(pool.runTaskParams({ securityGroup: process.env.SPIKE_SG_EXEC_SEALED }))
      );
      const arn = r.tasks?.[0]?.taskArn;
      const events: Array<{ atMs: number; status: string; reason?: string }> = [];
      let last = "";
      for (;;) {
        await sleep(2000);
        const t = await pool.describe(arn!);
        const status = t?.lastStatus ?? "?";
        if (status !== last)
          events.push({ atMs: Date.now() - t0, status, reason: t?.stoppedReason });
        last = status;
        if (status === "STOPPED")
          return send(res, 200, {
            arn,
            events,
            stoppedReason: t?.stoppedReason,
            stopCode: t?.stopCode,
            totalMs: Date.now() - t0
          });
        if (Date.now() - t0 > 600_000)
          return send(res, 200, { arn, events, gaveUpAfterMs: Date.now() - t0 });
      }
    }
    case "/admin/slots":
      SLOTS = Number(url.searchParams.get("n") ?? 4);
      return send(res, 200, { slots: SLOTS });
    case "/admin/echo":
      return send(res, 200, {
        hostUrl,
        epoch: pool.epoch,
        startedAt,
        inFlightInvocations,
        processMode: pool.processMode
      });
  }
  send(res, 404, { error: "not_found" });
}

const startedAt = new Date().toISOString();
const streams = new Set<ServerResponse>();
function stream(url: URL, res: ServerResponse) {
  const doc = url.searchParams.get("doc") ?? "doc";
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  res.write(`event: open\ndata: ${JSON.stringify({ doc, host: startedAt })}\n\n`);
  let n = 0;
  const timer = setInterval(
    () => res.write(`event: tick\ndata: ${JSON.stringify({ doc, n: ++n, at: Date.now() })}\n\n`),
    1000
  );
  streams.add(res);
  res.on("close", () => {
    clearInterval(timer);
    streams.delete(res);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/healthz")
      return send(res, 200, { ok: true, startedAt, epoch: pool.epoch, streams: streams.size });
    if (url.pathname === "/invoke") return await invoke(req, res);
    if (url.pathname === "/callback") return await callback(req, res);
    if (url.pathname === "/stream") return stream(url, res);
    if (url.pathname.startsWith("/admin/")) return await admin(url, req, res);
    send(res, 404, { error: "not_found" });
  } catch (e: any) {
    send(res, 500, { error: e.message });
  }
});

await discoverHostUrl();
await migrate();
await warm();
pool.setEpoch(
  Number(
    (await db.query("insert into hosts (note) values ($1) returning epoch", [hostUrl])).rows[0]
      .epoch
  )
);
const adopted = await pool.adopt();
pool.start();
server.listen(PORT, () =>
  console.log(
    `[host] epoch ${pool.epoch} listening on ${PORT}, hostUrl ${hostUrl}, slots ${SLOTS}, deadline ${DEADLINE_MS} ms, adopted ${adopted.length} tasks`
  )
);

// Deployment drain: finish streams and in-flight invocations; the exec tasks
// stay up for the replacement host to adopt.
process.on("SIGTERM", async () => {
  shuttingDown = true;
  console.log(
    `[host] epoch ${pool.epoch} SIGTERM with ${streams.size} streams and ${inFlightInvocations} invocations open`
  );
  for (const s of streams) s.end(`event: bye\ndata: {"reason":"sigterm"}\n\n`);
  server.close();
  const t0 = Date.now();
  while (inFlightInvocations > 0 && Date.now() - t0 < 20_000) await sleep(100);
  console.log(
    `[host] epoch ${pool.epoch} exiting after ${Date.now() - t0} ms; ${inFlightInvocations} invocations abandoned`
  );
  process.exit(0);
});
